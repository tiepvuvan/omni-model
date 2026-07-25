import { ConfigError, type Logger } from "@omni-model/core";
import type { PgPoolLike } from "@omni-model/postgres";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin as adminPlugin } from "better-auth/plugins";

/** Where Better Auth's own routes live, under the admin surface. */
export const AUTH_BASE_PATH = "/admin/api/auth";

/** Better Auth requires at least this much entropy in its signing secret. */
const MIN_SECRET_LENGTH = 32;

export const ADMIN_SECRET_VARIABLE = "OMNI_ADMIN_SECRET";

export interface AdminAuthOptions {
  /**
   * The same pool everything else uses. Better Auth owns its own tables
   * (`user`, `session`, `account`, `verification`); sharing the pool keeps the
   * connection count flat.
   */
  pool: PgPoolLike;
  /** Signing secret for sessions. At least 32 characters. */
  secret: string;
  /** Public origin, needed for correct cookies behind a proxy. */
  baseURL?: string;
  /** Extra origins allowed to send credentialed requests (a separate dashboard). */
  trustedOrigins?: readonly string[];
  logger?: Logger;
}

/**
 * Build the admin authentication instance.
 *
 * Email and password only, plus the `admin` plugin for roles and user
 * management. There is deliberately no social login and no email sending: this
 * is an operator surface for a self-hosted proxy, and every additional identity
 * provider is another thing that has to be configured before anyone can log in.
 */
export function createAdminAuth(options: AdminAuthOptions) {
  if (options.secret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(
      `${ADMIN_SECRET_VARIABLE} must be at least ${MIN_SECRET_LENGTH} characters ` +
        `(got ${options.secret.length}). Generate one with: openssl rand -base64 32`,
    );
  }
  return betterAuth({
    // `database` accepts a pg Pool directly, using the built-in Kysely adapter —
    // which is also what makes programmatic migration possible below.
    database: options.pool as never,
    secret: options.secret,
    basePath: AUTH_BASE_PATH,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.trustedOrigins === undefined
      ? {}
      : { trustedOrigins: [...options.trustedOrigins] }),
    emailAndPassword: { enabled: true },
    plugins: [adminPlugin()],
  });
}

/**
 * The concrete instance type, inferred from the call.
 *
 * Annotating it as `Auth<BetterAuthOptions>` would not typecheck: Better Auth's
 * return type is parameterised by the exact options given, and the plugin list
 * narrows it.
 */
export type AdminAuth = ReturnType<typeof createAdminAuth>;

/**
 * The slice of an auth instance the HTTP layer actually uses.
 *
 * Narrower than {@link AdminAuth} on purpose. That type is inferred all the way
 * down to every plugin endpoint, so nothing can stand in for it — which would
 * make the admin routes untestable without a live database behind Better Auth's
 * migrator. Depending on the two members that matter keeps authorization,
 * validation and the config/secret/log endpoints testable offline, and leaves
 * the real instance to the integration suite.
 */
export interface AdminAuthLike {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: { headers: Headers }): Promise<unknown>;
  };
}

/**
 * Create Better Auth's tables.
 *
 * Runs after our own migrations, never interleaved: two migrators taking
 * different locks on one database is how you get a deadlock at boot. Only the
 * built-in Kysely adapter supports this, which is the reason the pool is passed
 * in raw rather than through an ORM.
 */
export async function migrateAdminSchema(auth: AdminAuth, logger?: Logger): Promise<void> {
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
  if (toBeCreated.length === 0 && toBeAdded.length === 0) return;
  logger?.info("applying admin auth migrations", {
    tables: toBeCreated.length,
    columns: toBeAdded.length,
  });
  await runMigrations();
}

/**
 * Whether any operator account exists.
 *
 * This is the whole basis of first-run gating, so it queries the table directly
 * rather than going through an authenticated API — at the moment it matters,
 * there is nobody to authenticate as.
 */
export async function hasAnyAdminUser(pool: PgPoolLike): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM "user" LIMIT 1');
  return result.rows.length > 0;
}

/** Count operators, for reporting. */
export async function adminUserCount(pool: PgPoolLike): Promise<number> {
  const result = await pool.query('SELECT count(*)::int AS n FROM "user"');
  const value = result.rows[0]?.n;
  return typeof value === "number" ? value : 0;
}

/**
 * Create an operator without going through HTTP.
 *
 * The non-interactive path to a usable deployment: an automated deploy can seed
 * an operator without ever exposing a public sign-up endpoint, and it is also
 * the way back in once sign-up has closed.
 */
export async function createAdminUser(
  auth: AdminAuth,
  input: { email: string; password: string; name?: string },
): Promise<{ id: string; email: string }> {
  const result = await auth.api.signUpEmail({
    body: {
      email: input.email,
      password: input.password,
      name: input.name ?? input.email,
    },
  });
  const user = (result as { user?: { id?: unknown; email?: unknown } }).user;
  if (typeof user?.id !== "string") {
    throw new ConfigError("creating the operator account returned no user");
  }
  return { id: user.id, email: typeof user.email === "string" ? user.email : input.email };
}

/**
 * Grant the admin role.
 *
 * The `admin` plugin defaults a new account to `user`, which can sign in but
 * reaches nothing — so an operator has to be promoted explicitly. A direct
 * update is the only way to do it for the *first* one, since there is nobody
 * with permission to promote them yet.
 */
export async function grantAdminRole(pool: PgPoolLike, email: string): Promise<boolean> {
  const result = await pool.query('UPDATE "user" SET role = $2 WHERE email = $1 RETURNING id', [
    email,
    "admin",
  ]);
  return result.rows.length > 0;
}

/**
 * Promote the account that just signed up, if it is the only one.
 *
 * Without this, first-run over HTTP dead-ends: sign-up is open while no operator
 * exists, but the `admin` plugin defaults the new account to `user` — so the
 * person who just created the deployment's only account would be refused by
 * every admin route.
 *
 * The `count(*) = 1` guard closes the race where two sign-ups both pass the
 * open-gate check: whichever one is not alone stays a plain user rather than
 * both becoming operators. That leaves a stranded account, which an operator can
 * delete — strictly better than an unintended second operator.
 */
export async function promoteSoleUser(pool: PgPoolLike, userId: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE "user" SET role = $2 WHERE id = $1 AND (SELECT count(*) FROM "user") = 1 RETURNING id',
    [userId, "admin"],
  );
  return result.rows.length > 0;
}

/** The created user's id from a Better Auth sign-up response, or null. */
export async function signUpUserId(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const user = (body as { user?: { id?: unknown } } | null)?.user;
    return typeof user?.id === "string" ? user.id : null;
  } catch {
    return null;
  }
}
