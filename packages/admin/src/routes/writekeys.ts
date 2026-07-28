import { badRequest, notFound } from "@omni-model/core";
import { queryRequestLogs } from "@omni-model/postgres";
import { Hono } from "hono";
import { z } from "zod";
import type { AdminDeps } from "../deps.js";
import { type AdminEnv, actorOf } from "../session.js";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  /** Null or omitted means unrestricted; an empty array parks the key. */
  allowedModels: z.array(z.string().min(1)).nullable().optional(),
  /** Three-state: omitted inherits the global `logging.content`. */
  captureContent: z.boolean().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Epoch milliseconds. */
  expiresAt: z.number().int().positive().nullable().optional(),
});

interface UsageSummary {
  totalTokens: number;
  lastUsedAt: number | null;
  lastModel: string | null;
}

async function usageByWriteKey(deps: AdminDeps): Promise<Map<string, UsageSummary>> {
  if (deps.pool === null) return new Map();
  const result = await deps.pool.query(
    "SELECT write_key_id, coalesce(sum(total_tokens), 0)::bigint AS total_tokens, " +
      "max(ts) AS last_used_at, " +
      "(array_agg(model_requested ORDER BY ts DESC) " +
      "FILTER (WHERE model_requested <> ''))[1] AS last_model " +
      "FROM omni_request_logs WHERE write_key_id IS NOT NULL GROUP BY write_key_id",
  );
  return new Map(
    result.rows.map((row) => [
      String(row.write_key_id),
      {
        totalTokens: Number(row.total_tokens),
        lastUsedAt:
          row.last_used_at instanceof Date
            ? row.last_used_at.getTime()
            : new Date(String(row.last_used_at)).getTime(),
        lastModel: row.last_model === null ? null : String(row.last_model),
      },
    ]),
  );
}

export function createWriteKeyRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.get("/write-keys", async (c) => {
    // Descriptions only. There is no endpoint that returns a key, because after
    // creation the plaintext does not exist anywhere.
    const [writeKeys, usage] = await Promise.all([deps.writeKeys.list(), usageByWriteKey(deps)]);
    return c.json({
      writeKeys: writeKeys.map((writeKey) => ({
        ...writeKey,
        usage: usage.get(writeKey.id) ?? {
          totalTokens: 0,
          lastUsedAt: null,
          lastModel: null,
        },
      })),
    });
  });

  app.post("/write-keys", async (c) => {
    const body = createSchema.parse(await c.req.json());
    const actor = actorOf(c);
    const created = await deps.writeKeys.create({
      name: body.name,
      createdBy: actor.email,
      ...(body.allowedModels === undefined ? {} : { allowedModels: body.allowedModels }),
      ...(body.captureContent === undefined ? {} : { captureContent: body.captureContent }),
      ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
      ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
    });
    deps.logger?.info("write key created", {
      id: created.writeKey.id,
      name: created.writeKey.name,
      by: actor.email,
    });
    // The one and only time the plaintext is returned; it is unrecoverable after.
    return c.json({ writeKey: created.writeKey, secret: created.secret }, 201);
  });

  app.delete("/write-keys/:id", async (c) => {
    const id = c.req.param("id");
    const revoked = await deps.writeKeys.revoke(id);
    if (!revoked) {
      const existing = await deps.writeKeys.get(id);
      if (existing === null) throw notFound(`write key "${id}" does not exist`);
      // Already revoked: report it rather than pretending something changed.
      return c.json({ revoked: false, alreadyRevoked: true });
    }
    deps.logger?.info("write key revoked", { id, by: actorOf(c).email });
    return c.json({ revoked: true });
  });

  app.get("/write-keys/:id/usage", async (c) => {
    const id = c.req.param("id");
    if ((await deps.writeKeys.get(id)) === null) {
      throw notFound(`write key "${id}" does not exist`);
    }
    if (deps.pool === null) throw badRequest("usage history requires PostgreSQL storage");

    const sinceHours = Number(c.req.query("hours") ?? 24);
    if (!Number.isFinite(sinceHours) || sinceHours <= 0) {
      throw badRequest("hours must be a positive number");
    }
    const since = Date.now() - sinceHours * 3_600_000;
    const rows = await queryRequestLogs(deps.pool, { writeKeyId: id, since, limit: 1000 });
    return c.json({
      windowHours: sinceHours,
      requests: rows.length,
      failed: rows.filter((row) => row.status >= 400).length,
      totalTokens: rows.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0),
      recent: rows.slice(0, 20),
    });
  });

  return app;
}
