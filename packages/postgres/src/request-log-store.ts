import type { Logger, RequestLogEntry, RequestLogWriter } from "@omni-model/core";
import type { PgPoolLike, PgQueryResult } from "./pool.js";

/** Columns written per log row, in parameter order. */
const INSERT_COLUMNS =
  "id, ts, request_id, write_key_id, user_id, device_id, auth_provider, model_requested, " +
  "model_routed, provider_id, route_name, stream, status, error_code, prompt_tokens, " +
  "completion_tokens, total_tokens, latency_ms, ttfb_ms, ip, user_agent, rate_limit_rule";

const FIELDS_PER_ROW = 22;

/** Advisory-lock key for the retention sweep. Arbitrary but permanent. */
const SWEEP_LOCK_ID = 1_869_768_810;

function uuidOrNull(value: string | null): string | null {
  // `write_key_id` is a UUID column; a non-UUID would abort the whole batch, and
  // one malformed value must not cost every other row in it.
  if (value === null) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

/**
 * Batched writer for `omni_request_logs`, with content in
 * `omni_request_contents`.
 *
 * One multi-row INSERT per batch rather than a statement per row: at a few
 * thousand requests a minute the round trips, not the inserts, are the cost.
 */
export class PostgresRequestLogWriter implements RequestLogWriter {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  async write(entries: readonly RequestLogEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const ids = entries.map(() => crypto.randomUUID());
    const values: unknown[] = [];
    const rows: string[] = [];
    entries.forEach((entry, index) => {
      const base = index * FIELDS_PER_ROW;
      rows.push(
        `($${base + 1}, to_timestamp($${base + 2} / 1000.0), ` +
          Array.from({ length: FIELDS_PER_ROW - 2 }, (_, i) => `$${base + 3 + i}`).join(", ") +
          ")",
      );
      values.push(
        ids[index],
        entry.ts,
        entry.requestId,
        uuidOrNull(entry.writeKeyId),
        entry.userId,
        entry.deviceId,
        entry.authProvider,
        entry.modelRequested ?? "",
        entry.modelRouted,
        entry.providerId,
        entry.routeName,
        entry.stream,
        entry.status,
        entry.errorCode,
        entry.promptTokens,
        entry.completionTokens,
        entry.totalTokens,
        entry.latencyMs,
        entry.ttfbMs,
        entry.ip,
        entry.userAgent,
        entry.rateLimitRule,
      );
    });

    await this.pool.query(
      `INSERT INTO omni_request_logs (${INSERT_COLUMNS}) VALUES ${rows.join(", ")}`,
      values,
    );

    const withContent = entries
      .map((entry, index) => ({ entry, id: ids[index] as string }))
      .filter((row) => row.entry.content !== undefined);
    if (withContent.length === 0) return;

    const contentValues: unknown[] = [];
    const contentRows: string[] = [];
    withContent.forEach((row, index) => {
      const base = index * 4;
      contentRows.push(`($${base + 1}, $${base + 2}::jsonb, $${base + 3}, $${base + 4})`);
      contentValues.push(
        row.id,
        JSON.stringify(row.entry.content?.messages ?? null),
        row.entry.content?.completion ?? null,
        row.entry.content?.truncated ?? false,
      );
    });
    await this.pool.query(
      "INSERT INTO omni_request_contents (request_log_id, messages, completion, truncated) " +
        `VALUES ${contentRows.join(", ")}`,
      contentValues,
    );
  }
}

export interface RequestLogQuery {
  /** Newest first, starting strictly before this timestamp (epoch ms). */
  before?: number;
  since?: number;
  writeKeyId?: string;
  userId?: string;
  /** The proxy-generated id a client was given, for looking up one request. */
  requestId?: string;
  /** Only failures. */
  minStatus?: number;
  limit?: number;
  /** Include captured prompt/completion text. Off by default. */
  includeContent?: boolean;
}

export interface RequestLogRow extends RequestLogEntry {
  /** Database row id, distinct from the proxy-generated `requestId`. */
  id: string;
}

/**
 * Read request logs, newest first.
 *
 * Content is opt-in per query even when it was captured, so a dashboard listing
 * usage does not haul prompt text across the wire — and so an admin API can
 * gate reading content separately from reading metrics.
 */
export async function queryRequestLogs(
  pool: PgPoolLike,
  query: RequestLogQuery = {},
): Promise<RequestLogRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (clause: string, value: unknown): void => {
    values.push(value);
    where.push(clause.replace("$?", `$${values.length}`));
  };

  if (query.before !== undefined) add("l.ts < to_timestamp($? / 1000.0)", query.before);
  if (query.since !== undefined) add("l.ts >= to_timestamp($? / 1000.0)", query.since);
  if (query.writeKeyId !== undefined) add("l.write_key_id = $?", query.writeKeyId);
  if (query.userId !== undefined) add("l.user_id = $?", query.userId);
  if (query.requestId !== undefined) add("l.request_id = $?", query.requestId);
  if (query.minStatus !== undefined) add("l.status >= $?", query.minStatus);
  values.push(Math.min(Math.max(query.limit ?? 100, 1), 1000));
  const limitParam = `$${values.length}`;

  const content = query.includeContent === true;
  const result = await pool.query(
    `SELECT l.*${content ? ", c.messages, c.completion, c.truncated" : ""} ` +
      "FROM omni_request_logs l " +
      (content ? "LEFT JOIN omni_request_contents c ON c.request_log_id = l.id " : "") +
      (where.length === 0 ? "" : `WHERE ${where.join(" AND ")} `) +
      `ORDER BY l.ts DESC LIMIT ${limitParam}`,
    values,
  );
  return result.rows.map((row) => toRow(row, content));
}

function millis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toRow(row: Record<string, unknown>, withContent: boolean): RequestLogRow {
  const entry: RequestLogRow = {
    id: String(row.id),
    requestId: str(row.request_id) ?? "",
    ts: millis(row.ts),
    writeKeyId: str(row.write_key_id),
    userId: str(row.user_id),
    deviceId: str(row.device_id),
    authProvider: str(row.auth_provider),
    modelRequested: str(row.model_requested),
    modelRouted: str(row.model_routed),
    providerId: str(row.provider_id),
    routeName: str(row.route_name),
    stream: row.stream === true,
    status: num(row.status) ?? 0,
    errorCode: str(row.error_code),
    rateLimitRule: str(row.rate_limit_rule),
    promptTokens: num(row.prompt_tokens),
    completionTokens: num(row.completion_tokens),
    totalTokens: num(row.total_tokens),
    latencyMs: num(row.latency_ms),
    ttfbMs: num(row.ttfb_ms),
    ip: str(row.ip),
    userAgent: str(row.user_agent),
  };
  if (withContent && (row.messages !== null || row.completion !== null)) {
    entry.content = {
      messages: row.messages ?? null,
      completion: str(row.completion),
      truncated: row.truncated === true,
    };
  }
  return entry;
}

export interface SweepResult {
  /** False when another replica held the lock, so this call did nothing. */
  ran: boolean;
  logsDeleted: number;
  contentsDeleted: number;
}

/**
 * Delete logs past their retention window.
 *
 * Guarded by `pg_try_advisory_lock`, which is *non-blocking*: a replica that
 * loses the race returns immediately rather than queueing behind a long delete.
 * Every replica can therefore run this on a timer and exactly one does the work.
 *
 * Content is swept on its own clock, so usage history can outlive the prompts.
 */
export async function sweepRequestLogs(
  pool: PgPoolLike,
  options: { retentionMs: number; contentRetentionMs: number; logger?: Logger },
): Promise<SweepResult> {
  if (pool.connect === undefined) {
    throw new Error("sweeping request logs needs a pool that supports connect()");
  }
  const client = await pool.connect();
  try {
    const acquired = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [
      SWEEP_LOCK_ID,
    ]);
    if (acquired.rows[0]?.locked !== true) {
      return { ran: false, logsDeleted: 0, contentsDeleted: 0 };
    }
    try {
      // Content first: deleting a log row cascades its content anyway, but the
      // shorter content clock has to be applied to rows whose metadata stays.
      const contents = await client.query(
        "DELETE FROM omni_request_contents WHERE request_log_id IN (" +
          "SELECT id FROM omni_request_logs WHERE ts < now() - $1::float8 * interval '1 millisecond'" +
          ")",
        [options.contentRetentionMs],
      );
      const logs = await client.query(
        "DELETE FROM omni_request_logs WHERE ts < now() - $1::float8 * interval '1 millisecond'",
        [options.retentionMs],
      );
      const result: SweepResult = {
        ran: true,
        logsDeleted: rowCount(logs),
        contentsDeleted: rowCount(contents),
      };
      if (result.logsDeleted > 0 || result.contentsDeleted > 0) {
        options.logger?.info("swept expired request logs", {
          logs: result.logsDeleted,
          contents: result.contentsDeleted,
        });
      }
      return result;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [SWEEP_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

function rowCount(result: PgQueryResult): number {
  return typeof result.rowCount === "number" ? result.rowCount : 0;
}
