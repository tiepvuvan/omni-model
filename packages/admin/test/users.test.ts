import type { Logger } from "@omni-model/core";
import type { PgPoolLike, PgQueryResult } from "@omni-model/postgres";
import { describe, expect, it } from "vitest";
import { createTestAdmin, errorOf } from "./helpers.js";

interface StoredUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  createdAt: Date;
}

interface StoredInvite {
  id: string;
  email: string;
  tokenHash: string;
  invitedBy: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

class TeamPool implements PgPoolLike {
  readonly users: StoredUser[] = [
    {
      id: "u-root",
      email: "root@example.test",
      name: "Root",
      role: "admin",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  ];
  readonly invites: StoredInvite[] = [];

  async query(text: string, values: unknown[] = []): Promise<PgQueryResult> {
    const sql = text.replace(/\s+/g, " ").trim();
    const rows = (items: Record<string, unknown>[]): PgQueryResult => ({
      rows: items,
      rowCount: items.length,
    });

    if (sql.startsWith('SELECT id, email, name, role, "createdAt"')) {
      return rows(this.users.map((user) => ({ ...user })));
    }
    if (sql.includes("FROM omni_admin_invites") && sql.includes("ORDER BY created_at DESC")) {
      return rows(
        this.invites
          .filter((invite) => this.pending(invite))
          .map((invite) => this.inviteRow(invite)),
      );
    }
    if (sql.startsWith('SELECT id FROM "user" WHERE lower(email)')) {
      const email = String(values[0]);
      return rows(
        this.users
          .filter((user) => user.email.toLowerCase() === email)
          .map((user) => ({ id: user.id })),
      );
    }
    if (sql.startsWith("SELECT id FROM omni_admin_invites")) {
      const email = String(values[0]);
      return rows(
        this.invites
          .filter((invite) => invite.email.toLowerCase() === email && this.pending(invite))
          .map((invite) => ({ id: invite.id })),
      );
    }
    if (sql.startsWith("INSERT INTO omni_admin_invites")) {
      const invite: StoredInvite = {
        id: String(values[0]),
        email: String(values[1]),
        tokenHash: String(values[2]),
        invitedBy: String(values[3]),
        createdAt: new Date("2026-01-15T12:00:00Z"),
        expiresAt: values[4] as Date,
        acceptedAt: null,
        revokedAt: null,
      };
      this.invites.push(invite);
      return rows([this.inviteRow(invite)]);
    }
    if (sql.includes("FROM omni_admin_invites") && sql.includes("WHERE token_hash = $1")) {
      const tokenHash = String(values[0]);
      const invite = this.invites.find(
        (candidate) => candidate.tokenHash === tokenHash && this.pending(candidate),
      );
      return rows(invite === undefined ? [] : [this.inviteRow(invite)]);
    }
    if (sql.startsWith('SELECT id, role FROM "user"')) {
      const email = String(values[0]);
      const user = this.users.find((candidate) => candidate.email.toLowerCase() === email);
      return rows(user === undefined ? [] : [{ id: user.id, role: user.role }]);
    }
    if (sql.startsWith('UPDATE "user" SET role')) {
      const email = String(values[0]);
      let user = this.users.find((candidate) => candidate.email.toLowerCase() === email);
      if (user === undefined) {
        user = {
          id: `u-${this.users.length + 1}`,
          email,
          name: email,
          role: null,
          createdAt: new Date(),
        };
        this.users.push(user);
      }
      user.role = String(values[1]);
      return rows([{ id: user.id }]);
    }
    if (sql.startsWith("UPDATE omni_admin_invites") && sql.includes("accepted_at = now()")) {
      const invite = this.invites.find(
        (candidate) => candidate.id === values[0] && this.pending(candidate),
      );
      if (invite === undefined) return rows([]);
      invite.acceptedAt = new Date();
      return rows([{ id: invite.id }]);
    }
    if (sql.startsWith("UPDATE omni_admin_invites") && sql.includes("revoked_at = now()")) {
      const invite = this.invites.find(
        (candidate) => candidate.id === values[0] && this.pending(candidate),
      );
      if (invite === undefined) return rows([]);
      invite.revokedAt = new Date();
      return rows([{ id: invite.id }]);
    }
    throw new Error(`unexpected team query: ${sql}`);
  }

  private pending(invite: StoredInvite): boolean {
    return (
      invite.acceptedAt === null &&
      invite.revokedAt === null &&
      invite.expiresAt.getTime() > Date.now()
    );
  }

  private inviteRow(invite: StoredInvite): Record<string, unknown> {
    return {
      id: invite.id,
      email: invite.email,
      invitedBy: invite.invitedBy,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    };
  }
}

describe("dashboard users and invitation links", () => {
  it("creates an email-bound link without storing its bearer token", async () => {
    const pool = new TeamPool();
    const admin = await createTestAdmin({ pool });

    const response = await admin.call("/admin/api/users/invites", {
      method: "POST",
      body: JSON.stringify({ email: "New.Member@Example.test" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      invite: { email: string };
      link: string;
    };
    expect(body.invite.email).toBe("new.member@example.test");
    expect(body.link).toMatch(/^http:\/\/admin\.test\/admin\/accept-invite\?token=omi_[a-f0-9]+$/);
    expect(pool.invites[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.link).not.toContain(pool.invites[0]?.tokenHash ?? "missing");
  });

  it("refuses an existing user and duplicate pending invitation", async () => {
    const pool = new TeamPool();
    const admin = await createTestAdmin({ pool });

    const existing = await admin.call("/admin/api/users/invites", {
      method: "POST",
      body: JSON.stringify({ email: "root@example.test" }),
    });
    expect(existing.status).toBe(400);
    expect((await errorOf(existing)).code).toBe("user_already_exists");

    const first = await admin.call("/admin/api/users/invites", {
      method: "POST",
      body: JSON.stringify({ email: "pending@example.test" }),
    });
    expect(first.status).toBe(201);
    const duplicate = await admin.call("/admin/api/users/invites", {
      method: "POST",
      body: JSON.stringify({ email: "pending@example.test" }),
    });
    expect(duplicate.status).toBe(400);
    expect((await errorOf(duplicate)).code).toBe("invite_already_exists");
  });

  it("accepts without a session, grants admin access, and consumes the link", async () => {
    const pool = new TeamPool();
    const admin = await createTestAdmin({ pool });
    const created = (await (
      await admin.call("/admin/api/users/invites", {
        method: "POST",
        body: JSON.stringify({ email: "teammate@example.test" }),
      })
    ).json()) as { link: string };
    const token = new URL(created.link).searchParams.get("token");
    expect(token).not.toBeNull();

    const inspection = await admin.call(`/admin/api/invites/${token}`, { session: null });
    expect(inspection.status).toBe(200);
    expect(await inspection.json()).toMatchObject({
      invite: { email: "teammate@example.test" },
    });

    const accepted = await admin.call(`/admin/api/invites/${token}/accept`, {
      method: "POST",
      session: null,
      body: JSON.stringify({ name: "Team Mate", password: "long enough password" }),
    });
    expect(accepted.status).toBe(200);
    expect(pool.users.find((user) => user.email === "teammate@example.test")?.role).toBe("admin");

    const replay = await admin.call(`/admin/api/invites/${token}`, { session: null });
    expect(replay.status).toBe(404);
  });

  it("revokes a pending link and makes it unavailable", async () => {
    const pool = new TeamPool();
    const admin = await createTestAdmin({ pool });
    const created = (await (
      await admin.call("/admin/api/users/invites", {
        method: "POST",
        body: JSON.stringify({ email: "later@example.test" }),
      })
    ).json()) as { invite: { id: string }; link: string };

    const revoke = await admin.call(`/admin/api/users/invites/${created.invite.id}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(200);

    const token = new URL(created.link).searchParams.get("token");
    expect((await admin.call(`/admin/api/invites/${token}`, { session: null })).status).toBe(404);
  });

  it("never writes an invitation bearer token to an error log", async () => {
    const events: { message: string; fields?: Record<string, unknown> }[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message, fields) =>
        events.push({ message, ...(fields === undefined ? {} : { fields }) }),
    };
    const pool: PgPoolLike = {
      query: async () => {
        throw new Error("database unavailable");
      },
    };
    const admin = await createTestAdmin({ pool, logger });
    const token = "omi_plaintext-bearer-secret";

    const response = await admin.call(`/admin/api/invites/${token}`, { session: null });

    expect(response.status).toBe(500);
    expect(JSON.stringify(events)).not.toContain(token);
    expect(events).toEqual([
      expect.objectContaining({
        message: "admin request failed",
        fields: expect.objectContaining({ path: expect.stringContaining("INVITE_TOKEN_REDACTED") }),
      }),
    ]);
  });
});
