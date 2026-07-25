import {
  ADMIN_SECRET_VARIABLE,
  createAdminAuth,
  createAdminUser,
  grantAdminRole,
  migrateAdminSchema,
} from "@omni-model/admin";
import { ConfigError, createConsoleLogger, interpolateDeep, type Logger } from "@omni-model/core";
import { createPgPool } from "@omni-model/postgres";
import { resolveConfigSource } from "./config.js";

/** Arguments for {@link createFirstOperator}. */
export interface CreateOperatorArgs {
  env: Record<string, string | undefined>;
  email: string;
  password: string;
  name?: string;
  logger?: Logger;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The database URL, read the same way the server reads it at boot.
 *
 * Deliberately shares `resolveConfigSource` + `interpolateDeep` with
 * {@link startServer} rather than reading `DATABASE_URL` directly: a deployment
 * that points the server at one database and this command at another is a much
 * worse failure than a missing variable, because the operator it creates lands
 * somewhere nobody logs in to.
 */
function postgresUrl(env: Record<string, string | undefined>): string {
  const { config } = resolveConfigSource({ env });
  const storage = record(
    record(config === undefined ? undefined : interpolateDeep(config, env))?.storage,
  );
  const type = typeof storage?.type === "string" ? storage.type : "memory";
  if (type !== "postgres") {
    throw new ConfigError(
      "create-admin needs PostgreSQL storage; set OMNI_STORAGE_TYPE=postgres and " +
        "OMNI_STORAGE_POSTGRES_URL",
    );
  }
  const url = storage?.url;
  if (typeof url !== "string" || url === "") {
    throw new ConfigError("create-admin needs a database URL (set OMNI_STORAGE_POSTGRES_URL)");
  }
  return url;
}

/**
 * Create an operator account with the `admin` role, without HTTP.
 *
 * This is the non-interactive path to a usable deployment, and the way back in
 * once sign-up has closed. It uses Better Auth's own sign-up API so the password
 * is hashed exactly as an HTTP sign-up would hash it, then promotes the account
 * with a direct update — the plugin's own promotion endpoint requires an
 * existing admin, which by definition does not exist the first time.
 *
 * Idempotent enough to be safe in a deploy script: creating an account that
 * already exists fails from Better Auth, and re-running against an existing
 * email can be recovered by promoting it instead.
 */
export async function createFirstOperator(
  args: CreateOperatorArgs,
): Promise<{ id: string | null; email: string; promoted: boolean }> {
  const secret = args.env[ADMIN_SECRET_VARIABLE];
  if (secret === undefined || secret.trim() === "") {
    throw new ConfigError(
      `${ADMIN_SECRET_VARIABLE} must be set: it signs the sessions this account will use`,
    );
  }
  const logger =
    args.logger ?? createConsoleLogger(args.env.OMNI_LOG_LEVEL === "debug" ? "debug" : "warn");
  const pool = await createPgPool(postgresUrl(args.env));
  try {
    // Passed through when set, purely to keep the library from warning about a
    // missing origin: this path issues no cookies and follows no redirects.
    const baseURL = args.env.OMNI_ADMIN_BASE_URL;
    const auth = createAdminAuth({
      pool,
      secret,
      logger,
      ...(baseURL === undefined || baseURL === "" ? {} : { baseURL }),
    });
    await migrateAdminSchema(auth, logger);
    let id: string | null = null;
    try {
      id = (
        await createAdminUser(auth, {
          email: args.email,
          password: args.password,
          ...(args.name === undefined ? {} : { name: args.name }),
        })
      ).id;
    } catch (error) {
      // An existing account is the common re-run: promote it rather than
      // failing, so a deploy script can be applied more than once.
      if (!(await grantAdminRole(pool, args.email))) throw error;
      logger.warn("an account with that email already existed; granted it the admin role");
      return { id: null, email: args.email, promoted: true };
    }
    // A fresh account defaults to the `user` role, which can sign in but reaches
    // nothing — so promotion is not optional.
    const promoted = await grantAdminRole(pool, args.email);
    if (!promoted) {
      throw new ConfigError(
        `created ${args.email} but could not grant it the admin role; promote it manually`,
      );
    }
    return { id, email: args.email, promoted };
  } finally {
    await pool.end?.();
  }
}
