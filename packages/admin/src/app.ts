import { ConfigError, forbidden, type Logger, OmniError } from "@omni-model/core";
import type { PgPoolLike } from "@omni-model/postgres";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  ADMIN_SECRET_VARIABLE,
  type AdminAuth,
  type AdminAuthLike,
  adminUserCount,
  createAdminAuth,
  hasAnyAdminUser,
  migrateAdminSchema,
  promoteSoleUser,
  signUpUserId,
} from "./auth.js";
import type { AdminDeps } from "./deps.js";
import { createCacheRoutes } from "./routes/cache.js";
import { createConfigRoutes } from "./routes/config.js";
import { createLogRoutes } from "./routes/logs.js";
import { createMetaRoutes } from "./routes/meta.js";
import { createSecretRoutes } from "./routes/secrets.js";
import { createWriteKeyRoutes } from "./routes/writekeys.js";
import { type AdminEnv, requireAdmin } from "./session.js";

export interface AdminAppOptions extends AdminDeps {
  /**
   * Signing secret for sessions. Required unless `auth` is injected; without
   * either there is no admin surface at all.
   */
  secret?: string;
  /** Public origin, for correct cookies behind a proxy. */
  baseURL?: string;
  /** Origins allowed to send credentialed requests (a separately hosted dashboard). */
  allowedOrigins?: readonly string[];
  /** The pool Better Auth stores its own tables in. */
  pool: PgPoolLike;
  /**
   * Use this auth instance instead of building one. The injector then owns the
   * schema, so `migrate()` becomes a no-op.
   */
  auth?: AdminAuthLike;
  logger?: Logger;
}

export interface AdminApp {
  app: Hono<AdminEnv>;
  auth: AdminAuthLike;
  /** Create Better Auth's tables. Run after the proxy's own migrations. */
  migrate(): Promise<void>;
}

/** Build the real Better Auth instance from the options. */
function buildAuth(options: AdminAppOptions): AdminAuth {
  if (options.secret === undefined) {
    throw new ConfigError(
      `the admin API needs a session signing secret (set ${ADMIN_SECRET_VARIABLE})`,
    );
  }
  return createAdminAuth({
    pool: options.pool,
    secret: options.secret,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.allowedOrigins === undefined ? {} : { trustedOrigins: options.allowedOrigins }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

/**
 * The admin surface, mounted at `/admin`.
 *
 * Everything under `/admin/api` requires an operator session except Better
 * Auth's own routes, which have to be reachable in order to sign in.
 */
export function createAdminApp(options: AdminAppOptions): AdminApp {
  const own = options.auth === undefined ? buildAuth(options) : null;
  const auth: AdminAuthLike = own ?? (options.auth as AdminAuthLike);

  const app = new Hono<AdminEnv>();

  app.onError((error, c) => {
    if (error instanceof OmniError) return error.toResponse();
    if (error instanceof z.ZodError) {
      // A malformed admin request is the caller's mistake, and the field-level
      // detail is what makes it fixable.
      return c.json(
        {
          error: {
            message: `invalid request body:\n${z.prettifyError(error)}`,
            type: "invalid_request_error",
            param: null,
            code: "invalid_body",
          },
        },
        400,
      );
    }
    options.logger?.error("admin request failed", {
      path: c.req.path,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      {
        error: {
          message: "internal server error",
          type: "api_error",
          param: null,
          code: null,
        },
      },
      500,
    );
  });

  // Before the routes, and with credentials: a dashboard on another origin sends
  // the session cookie, which a wildcard origin would forbid.
  if (options.allowedOrigins !== undefined && options.allowedOrigins.length > 0) {
    app.use(
      "/admin/*",
      cors({
        origin: [...options.allowedOrigins],
        credentials: true,
        allowHeaders: ["content-type"],
      }),
    );
  }

  /**
   * First-run signup, and only first-run.
   *
   * Gated here rather than through a library hook, so the rule is visible in the
   * routing table and testable without depending on Better Auth internals. Once
   * an operator exists this is closed permanently — otherwise a public admin
   * surface would let anyone create an account on it.
   */
  app.on(["POST"], "/admin/api/auth/sign-up/*", async (c) => {
    if (await hasAnyAdminUser(options.pool)) {
      throw forbidden(
        "sign-up is closed: an operator account already exists. Ask an existing operator " +
          "to create your account, or use the create-admin command.",
        { code: "signup_closed" },
      );
    }
    const response = await auth.handler(c.req.raw);
    if (!response.ok) return response;

    // The account that creates the deployment is its operator. Without this the
    // first-run flow dead-ends: the plugin defaults new accounts to `user`, so
    // the only account on the deployment would be refused by every admin route.
    const userId = await signUpUserId(response.clone());
    if (userId === null) {
      options.logger?.warn(
        "first sign-up returned no user id; grant the admin role with create-admin",
      );
    } else if (!(await promoteSoleUser(options.pool, userId))) {
      options.logger?.warn("first sign-up was not promoted; another account already existed", {
        userId,
      });
    } else {
      options.logger?.info("first operator created and granted the admin role", { userId });
    }
    return response;
  });

  /** Whether the deployment still needs its first operator. Unauthenticated by necessity. */
  app.get("/admin/api/setup", async (c) => {
    const users = await adminUserCount(options.pool);
    return c.json({ needsFirstOperator: users === 0, operators: users });
  });

  app.on(["GET", "POST"], "/admin/api/auth/*", (c) => auth.handler(c.req.raw));

  // Everything past here needs an operator session.
  app.use("/admin/api/*", requireAdmin(auth));

  app.get("/admin/api/me", (c) => c.json({ actor: c.get("actor") }));

  app.get("/admin/api/status", (c) => {
    const status = deps.holder.status();
    const bundle = deps.holder.current();
    return c.json({
      ...status,
      providers: bundle === null ? [] : [...bundle.providers.keys()],
      // The two layers separately, because "authentication is configured" is two
      // different facts: one is required and one is optional.
      userAuth: bundle?.userVerifier.name ?? null,
      appAuth: bundle === null ? [] : bundle.appVerifiers.map((verifier) => verifier.name),
      requireWriteKey: bundle?.requireWriteKey ?? null,
      logging: bundle?.logging ?? null,
    });
  });

  const deps: AdminDeps = options;
  const api = new Hono<AdminEnv>();
  api.route("/", createConfigRoutes(deps));
  api.route("/", createWriteKeyRoutes(deps));
  api.route("/", createSecretRoutes(deps));
  api.route("/", createLogRoutes(deps));
  api.route("/", createMetaRoutes(deps));
  api.route("/", createCacheRoutes(deps));
  app.route("/admin/api", api);

  return {
    app,
    auth,
    // Only the instance we built ourselves has a schema we are responsible for.
    migrate: async () => {
      if (own !== null) await migrateAdminSchema(own, options.logger);
    },
  };
}
