import { badRequest, notFound } from "@omni-model/core";
import { queryRequestLogs } from "@omni-model/postgres";
import { Hono } from "hono";
import type { AdminDeps } from "../deps.js";
import { type AdminEnv, actorOf } from "../session.js";

function positiveInt(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw badRequest(`${label} must be a positive number`);
  }
  return parsed;
}

export function createLogRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  const pool = () => {
    if (deps.pool === null) throw badRequest("request logs require PostgreSQL storage");
    return deps.pool;
  };

  app.get("/logs", async (c) => {
    const includeContent = c.req.query("includeContent") === "true";
    if (includeContent) {
      // Reading users' prompts is an accountable act, so it leaves a trace even
      // for an operator who is allowed to do it.
      deps.logger?.warn("request log content was read", {
        by: actorOf(c).email,
        writeKeyId: c.req.query("writeKeyId") ?? null,
        userId: c.req.query("userId") ?? null,
      });
    }
    const logs = await queryRequestLogs(pool(), {
      ...(positiveInt(c.req.query("before"), "before") === undefined
        ? {}
        : { before: positiveInt(c.req.query("before"), "before") as number }),
      ...(positiveInt(c.req.query("since"), "since") === undefined
        ? {}
        : { since: positiveInt(c.req.query("since"), "since") as number }),
      ...(c.req.query("writeKeyId") === undefined
        ? {}
        : { writeKeyId: c.req.query("writeKeyId") as string }),
      ...(c.req.query("userId") === undefined ? {} : { userId: c.req.query("userId") as string }),
      ...(positiveInt(c.req.query("minStatus"), "minStatus") === undefined
        ? {}
        : { minStatus: positiveInt(c.req.query("minStatus"), "minStatus") as number }),
      ...(positiveInt(c.req.query("limit"), "limit") === undefined
        ? {}
        : { limit: positiveInt(c.req.query("limit"), "limit") as number }),
      includeContent,
    });
    // Cursor for the next page: callers should not have to construct it.
    const oldest = logs.at(-1);
    return c.json({
      logs,
      nextBefore: oldest === undefined ? null : oldest.ts,
    });
  });

  app.get("/logs/:requestId", async (c) => {
    const requestId = c.req.param("requestId");
    const includeContent = c.req.query("includeContent") === "true";
    if (includeContent) {
      deps.logger?.warn("request log content was read", {
        by: actorOf(c).email,
        requestId,
      });
    }
    // Looked up by the id the *client* was given, which is what a user quotes.
    const [log] = await queryRequestLogs(pool(), { requestId, limit: 1, includeContent });
    if (log === undefined) throw notFound(`no request logged with id "${requestId}"`);
    return c.json({ log });
  });

  app.get("/usage/summary", async (c) => {
    const hours = positiveInt(c.req.query("hours"), "hours") ?? 24;
    const since = new Date(Date.now() - hours * 3_600_000);
    // Aggregated in SQL: pulling every row into the process to sum it would fall
    // over on exactly the busy deployment that most wants this number.
    const result = await pool().query(
      "SELECT l.write_key_id, k.name AS write_key_name, count(*)::int AS requests, " +
        "count(*) FILTER (WHERE l.status >= 400)::int AS failed, " +
        "coalesce(sum(l.total_tokens), 0)::bigint AS total_tokens, " +
        "coalesce(round(avg(l.latency_ms)), 0)::int AS avg_latency_ms " +
        "FROM omni_request_logs l LEFT JOIN omni_write_keys k ON k.id = l.write_key_id " +
        "WHERE l.ts >= $1 GROUP BY l.write_key_id, k.name ORDER BY requests DESC",
      [since],
    );
    return c.json({
      windowHours: hours,
      clients: result.rows.map((row) => ({
        writeKeyId: row.write_key_id === null ? null : String(row.write_key_id),
        writeKeyName: row.write_key_name === null ? null : String(row.write_key_name),
        requests: Number(row.requests),
        failed: Number(row.failed),
        totalTokens: Number(row.total_tokens),
        avgLatencyMs: Number(row.avg_latency_ms),
      })),
    });
  });

  return app;
}
