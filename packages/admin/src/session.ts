import { forbidden, unauthorized } from "@omni-model/core";
import type { Context, MiddlewareHandler } from "hono";
import type { AdminAuthLike } from "./auth.js";

/** The operator behind an admin request. */
export interface AdminActor {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

export interface AdminEnv {
  Variables: {
    actor: AdminActor | undefined;
  };
}

/** The role the `admin` plugin grants; anything else is a read-nothing user. */
const ADMIN_ROLE = "admin";

function actorFrom(session: unknown): AdminActor | null {
  if (typeof session !== "object" || session === null) return null;
  const user = (session as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) return null;
  const record = user as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  return {
    id: record.id,
    email: typeof record.email === "string" ? record.email : "",
    name: typeof record.name === "string" ? record.name : null,
    // The plugin stores a single role, or a comma-separated list for multi-role.
    role: typeof record.role === "string" ? record.role : "",
  };
}

/** Whether `role` grants admin, tolerating the plugin's comma-separated form. */
function isAdmin(role: string): boolean {
  return role
    .split(",")
    .map((part) => part.trim())
    .includes(ADMIN_ROLE);
}

/**
 * Require a signed-in operator with the admin role.
 *
 * Applied to every `/admin/api` route except Better Auth's own endpoints, which
 * have to be reachable in order to sign in. Two distinct failures on purpose:
 * 401 means "log in", 403 means "you are logged in but this account is not an
 * operator" — collapsing them would leave a non-admin user unable to tell that
 * their session is fine.
 */
export function requireAdmin(auth: AdminAuthLike): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const actor = actorFrom(session);
    if (actor === null) {
      throw unauthorized("sign in to use the admin API", { code: "admin_unauthenticated" });
    }
    if (!isAdmin(actor.role)) {
      throw forbidden("this account is not an operator", { code: "admin_forbidden" });
    }
    c.set("actor", actor);
    return next();
  };
}

/** The actor for this request. Present because `requireAdmin` ran first. */
export function actorOf(c: Context<AdminEnv>): AdminActor {
  const actor = c.get("actor");
  if (actor === undefined) {
    throw unauthorized("sign in to use the admin API", { code: "admin_unauthenticated" });
  }
  return actor;
}
