import { badRequest, notFound } from "@omni-model/core";
import type { PgPoolLike } from "@omni-model/postgres";
import { Hono } from "hono";
import { z } from "zod";
import type { AdminAuthLike } from "../auth.js";
import {
  acceptAdminInvite,
  createAdminInvite,
  findAdminInvite,
  listAdminTeam,
  revokeAdminInvite,
} from "../invites.js";
import { type AdminEnv, actorOf } from "../session.js";

const inviteBody = z.strictObject({ email: z.email() });
const acceptBody = z.strictObject({
  password: z.string().min(8),
  name: z.string().trim().min(1).optional(),
});

/** Protected team-member and invitation-management routes. */
export function createUserRoutes(pool: PgPoolLike, options: { baseURL?: string }): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.get("/users", async (c) => c.json(await listAdminTeam(pool)));

  app.post("/users/invites", async (c) => {
    const body = inviteBody.parse(await c.req.json());
    const created = await createAdminInvite(pool, {
      email: body.email,
      invitedBy: actorOf(c).email,
    });
    const origin = (options.baseURL ?? new URL(c.req.url).origin).replace(/\/+$/, "");
    const link = `${origin}/admin/accept-invite?token=${encodeURIComponent(created.token)}`;
    return c.json({ invite: created.invite, link }, 201);
  });

  app.delete("/users/invites/:id", async (c) => {
    const id = c.req.param("id");
    if (id === "") throw badRequest("invitation id is required");
    if (!(await revokeAdminInvite(pool, id))) {
      throw notFound("that invitation does not exist or is no longer pending");
    }
    return c.json({ revoked: true });
  });

  return app;
}

/** Public invite inspection and acceptance routes; possession of the token is authorization. */
export function createInviteAcceptanceRoutes(
  pool: PgPoolLike,
  auth: AdminAuthLike,
): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.get("/invites/:token", async (c) => {
    const invite = await findAdminInvite(pool, c.req.param("token"));
    return c.json({ invite: { email: invite.email, expiresAt: invite.expiresAt } });
  });

  app.post("/invites/:token/accept", async (c) => {
    const body = acceptBody.parse(await c.req.json());
    return c.json(
      await acceptAdminInvite(pool, auth, {
        token: c.req.param("token"),
        password: body.password,
        ...(body.name === undefined ? {} : { name: body.name }),
      }),
    );
  });

  return app;
}
