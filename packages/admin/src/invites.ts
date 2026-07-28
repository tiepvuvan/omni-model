import { badRequest, notFound } from "@omni-model/core";
import type { PgPoolLike } from "@omni-model/postgres";
import type { AdminAuthLike } from "./auth.js";
import { grantAdminRole } from "./auth.js";

/** Invite links are useful long enough to send asynchronously without lingering indefinitely. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A dashboard account returned to the Users screen. */
export interface AdminUserDescription {
  id: string;
  email: string;
  name: string;
  role: string | null;
  createdAt: number;
}

/** A pending, email-bound invitation. The bearer token is never stored or listed. */
export interface AdminInviteDescription {
  id: string;
  email: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

function inviteDescription(row: Record<string, unknown>): AdminInviteDescription {
  const createdAt = row.createdAt;
  const expiresAt = row.expiresAt;
  if (
    typeof row.id !== "string" ||
    typeof row.email !== "string" ||
    typeof row.invitedBy !== "string" ||
    !(createdAt instanceof Date) ||
    !(expiresAt instanceof Date)
  ) {
    throw new Error("database returned an invalid invitation row");
  }
  return {
    id: row.id,
    email: row.email,
    invitedBy: row.invitedBy,
    createdAt: createdAt.getTime(),
    expiresAt: expiresAt.getTime(),
  };
}

function userDescription(row: Record<string, unknown>): AdminUserDescription {
  const createdAt = row.createdAt;
  if (
    typeof row.id !== "string" ||
    typeof row.email !== "string" ||
    typeof row.name !== "string" ||
    !(createdAt instanceof Date)
  ) {
    throw new Error("database returned an invalid user row");
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: typeof row.role === "string" ? row.role : null,
    createdAt: createdAt.getTime(),
  };
}

function newInviteToken(): string {
  return `omi_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

async function tokenHash(token: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** List dashboard users and currently actionable invitations. */
export async function listAdminTeam(pool: PgPoolLike): Promise<{
  users: AdminUserDescription[];
  invites: AdminInviteDescription[];
}> {
  const [users, invites] = await Promise.all([
    pool.query(
      'SELECT id, email, name, role, "createdAt" AS "createdAt" FROM "user" ORDER BY "createdAt" ASC',
    ),
    pool.query(
      `SELECT id, email, invited_by AS "invitedBy", created_at AS "createdAt",
              expires_at AS "expiresAt"
         FROM omni_admin_invites
        WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
    ),
  ]);
  return {
    users: users.rows.map(userDescription),
    invites: invites.rows.map(inviteDescription),
  };
}

/** Create an email-bound invitation and return its bearer token exactly once. */
export async function createAdminInvite(
  pool: PgPoolLike,
  input: { email: string; invitedBy: string; now?: number },
): Promise<{ invite: AdminInviteDescription; token: string }> {
  const email = input.email.trim().toLowerCase();
  const existing = await pool.query('SELECT id FROM "user" WHERE lower(email) = $1 LIMIT 1', [
    email,
  ]);
  if (existing.rows.length > 0) {
    throw badRequest("that email already has access", {
      code: "user_already_exists",
      param: "email",
    });
  }

  const pending = await pool.query(
    `SELECT id FROM omni_admin_invites
      WHERE lower(email) = $1
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      LIMIT 1`,
    [email],
  );
  if (pending.rows.length > 0) {
    throw badRequest("that email already has a pending invitation", {
      code: "invite_already_exists",
      param: "email",
    });
  }

  const token = newInviteToken();
  const id = crypto.randomUUID();
  const expiresAt = new Date((input.now ?? Date.now()) + INVITE_TTL_MS);
  const inserted = await pool.query(
    `INSERT INTO omni_admin_invites
      (id, email, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, invited_by AS "invitedBy", created_at AS "createdAt",
               expires_at AS "expiresAt"`,
    [id, email, await tokenHash(token), input.invitedBy, expiresAt],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error("creating the invitation returned no row");
  return { invite: inviteDescription(row), token };
}

/** Revoke a pending invitation. Returns false when it is not actionable. */
export async function revokeAdminInvite(pool: PgPoolLike, id: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE omni_admin_invites
        SET revoked_at = now()
      WHERE id = $1
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING id`,
    [id],
  );
  return result.rows.length > 0;
}

/** Resolve an actionable bearer token without consuming it. */
export async function findAdminInvite(
  pool: PgPoolLike,
  token: string,
): Promise<AdminInviteDescription> {
  const result = await pool.query(
    `SELECT id, email, invited_by AS "invitedBy", created_at AS "createdAt",
            expires_at AS "expiresAt"
       FROM omni_admin_invites
      WHERE token_hash = $1
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      LIMIT 1`,
    [await tokenHash(token)],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw notFound("this invitation is invalid, expired, or has already been used", {
      code: "invite_unavailable",
    });
  }
  return inviteDescription(row);
}

function hasAdminRole(role: unknown): boolean {
  return (
    typeof role === "string" &&
    role
      .split(",")
      .map((part) => part.trim())
      .includes("admin")
  );
}

/**
 * Accept an invitation, creating or promoting its bound account and consuming it.
 *
 * An existing plain user can arise when account creation succeeded but a process
 * stopped before promotion. Treating that as recoverable keeps a valid invite
 * from becoming permanently stranded.
 */
export async function acceptAdminInvite(
  pool: PgPoolLike,
  auth: AdminAuthLike,
  input: { token: string; password: string; name?: string },
): Promise<{ email: string }> {
  const invite = await findAdminInvite(pool, input.token);
  const existing = await pool.query('SELECT id, role FROM "user" WHERE lower(email) = $1 LIMIT 1', [
    invite.email,
  ]);
  const user = existing.rows[0];

  if (user === undefined) {
    try {
      await auth.api.signUpEmail({
        body: {
          email: invite.email,
          password: input.password,
          name: input.name?.trim() || invite.email,
        },
      });
    } catch {
      throw badRequest("the account could not be created; request a new invitation", {
        code: "invite_signup_failed",
      });
    }
  }

  if (!hasAdminRole(user?.role) && !(await grantAdminRole(pool, invite.email))) {
    throw new Error("the invited account could not be granted admin access");
  }

  const consumed = await pool.query(
    `UPDATE omni_admin_invites
        SET accepted_at = now()
      WHERE id = $1
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING id`,
    [invite.id],
  );
  if (consumed.rows.length === 0) {
    throw notFound("this invitation is invalid, expired, or has already been used", {
      code: "invite_unavailable",
    });
  }
  return { email: invite.email };
}
