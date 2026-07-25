import type { Logger, RequestLogEntry, RequestLogWriter } from "@omni-model/core";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { createDb, type Db } from "./db.js";
import type { PgPoolLike, PgQueryResult } from "./pool.js";
import { requestContents, requestLogs } from "./schema.js";

/** Advisory-lock key for the retention sweep. Arbitrary but permanent. */
const SWEEP_LOCK_ID = 1_869_768_810;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrNull(value: string | null): string | null {
  // `write_key_id` is a UUID column; a non-UUID would abort the whole batch, and
  // one malformed value must not cost every other row in it.
  return value !== null && UUID.test(value) ? value : null;
}

/**
 * Batched writer for `omni_request_logs`, with content in
 * `omni_request_contents`.
 *
 * One multi-row INSERT per batch rather than a statement per row: at a few
 * thousand requests a minute the round trips, not the inserts, are the cost.
 */
export class PostgresRequestLogWriter implements RequestLogWriter {
  private readonly db: Db;

  constructor(pool: PgPoolLike) {
    this.db = createDb(pool);
  }

  async write(entries: readonly RequestLogEntry[]): Promise<void> {
    if (entries.length === 0) return;

    // Ids are generated here rather than by the default, so the content rows can
    // reference them without a second round trip to read them back.
    const ids = entries.map(() => crypto.randomUUID());
    await this.db.insert(requestLogs).values(
      entries.map((entry, index) => ({
        id: ids[index] as string,
        ts: new Date(entry.ts),
        requestId: entry.requestId,
        writeKeyId: uuidOrNull(entry.writeKeyId),
        userId: entry.userId,
        deviceId: entry.deviceId,
        authProvider: entry.authProvider,
        modelRequested: entry.modelRequested ?? "",
        modelRouted: entry.modelRouted,
        providerId: entry.providerId,
        routeName: entry.routeName,
        stream: entry.stream,
        status: entry.status,
        errorCode: entry.errorCode,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        totalTokens: entry.totalTokens,
        latencyMs: entry.latencyMs,
        ttfbMs: entry.ttfbMs,
        ip: entry.ip,
        userAgent: entry.userAgent,
        rateLimitRule: entry.rateLimitRule,
      })),
    );

    const withContent = entries
      .map((entry, index) => ({ entry, id: ids[index] as string }))
      .filter((row) => row.entry.content !== undefined);
    if (withContent.length === 0) return;

    await this.db.insert(requestContents).values(
      withContent.map((row) => ({
        requestLogId: row.id,
        messages: row.entry.content?.messages ?? null,
        completion: row.entry.content?.completion ?? null,
        truncated: row.entry.content?.truncated ?? false,
      })),
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

type LogRow = typeof requestLogs.$inferSelect;
type ContentRow = typeof requestContents.$inferSelect;

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
  const db = createDb(pool);
  const filters = [
    query.before === undefined ? undefined : lt(requestLogs.ts, new Date(query.before)),
    query.since === undefined ? undefined : gte(requestLogs.ts, new Date(query.since)),
    query.writeKeyId === undefined ? undefined : eq(requestLogs.writeKeyId, query.writeKeyId),
    query.userId === undefined ? undefined : eq(requestLogs.userId, query.userId),
    query.requestId === undefined ? undefined : eq(requestLogs.requestId, query.requestId),
    query.minStatus === undefined ? undefined : gte(requestLogs.status, query.minStatus),
  ].filter((filter) => filter !== undefined);
  const where = filters.length === 0 ? undefined : and(...filters);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);

  if (query.includeContent !== true) {
    const rows = await db
      .select()
      .from(requestLogs)
      .where(where)
      .orderBy(desc(requestLogs.ts))
      .limit(limit);
    return rows.map((row) => toRow(row, null));
  }

  const rows = await db
    .select({ log: requestLogs, content: requestContents })
    .from(requestLogs)
    .leftJoin(requestContents, eq(requestContents.requestLogId, requestLogs.id))
    .where(where)
    .orderBy(desc(requestLogs.ts))
    .limit(limit);
  return rows.map((row) => toRow(row.log, row.content));
}

function toRow(row: LogRow, content: ContentRow | null): RequestLogRow {
  const entry: RequestLogRow = {
    id: row.id,
    requestId: row.requestId ?? "",
    ts: row.ts.getTime(),
    writeKeyId: row.writeKeyId,
    userId: row.userId,
    deviceId: row.deviceId,
    authProvider: row.authProvider,
    modelRequested: row.modelRequested,
    modelRouted: row.modelRouted,
    providerId: row.providerId,
    routeName: row.routeName,
    stream: row.stream,
    status: row.status,
    errorCode: row.errorCode,
    rateLimitRule: row.rateLimitRule,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    latencyMs: row.latencyMs,
    ttfbMs: row.ttfbMs,
    ip: row.ip,
    userAgent: row.userAgent,
  };
  // Absent rather than null when nothing was captured, so a caller can tell
  // "content capture was off" from "the prompt was empty".
  if (content !== null && (content.messages !== null || content.completion !== null)) {
    entry.content = {
      messages: content.messages ?? null,
      completion: content.completion,
      truncated: content.truncated,
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
 * The lock is session-scoped, so it is taken on a checked-out client and
 * released in a `finally` — a pooled `query` might unlock on a different backend.
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
      const db = createDb(pool);
      const olderThan = (ms: number) =>
        lt(requestLogs.ts, sql`now() - ${ms}::float8 * interval '1 millisecond'`);

      // Content first: deleting a log row cascades its content anyway, but the
      // shorter content clock has to be applied to rows whose metadata stays.
      const contents = await db.delete(requestContents).where(
        inArray(
          requestContents.requestLogId,
          db
            .select({ id: requestLogs.id })
            .from(requestLogs)
            .where(olderThan(options.contentRetentionMs)),
        ),
      );
      const logs = await db.delete(requestLogs).where(olderThan(options.retentionMs));

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

function rowCount(result: PgQueryResult | { rowCount?: number | null }): number {
  return typeof result.rowCount === "number" ? result.rowCount : 0;
}
