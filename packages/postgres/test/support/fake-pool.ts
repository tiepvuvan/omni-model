import type { PgClientLike, PgPoolLike, PgQueryResult } from "../../src/pool.js";

interface Row {
  value: string;
  expiresAt: number | null;
}

const SELECT_SQL =
  /^SELECT value FROM omni_kv WHERE key = \$1 AND \(expires_at IS NULL OR expires_at > now\(\)\)$/;
const PUT_SQL =
  /^INSERT INTO omni_kv \(key, value, expires_at\) VALUES \(\$1, \$2, now\(\) \+ \$3::float8 \* interval '1 second'\) ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value, expires_at = EXCLUDED\.expires_at$/;
const DELETE_SQL = /^DELETE FROM omni_kv WHERE key = \$1$/;
const INCREMENT_SQL =
  /^INSERT INTO omni_kv \(key, value, expires_at\) VALUES \(\$1, \$2::text, now\(\) \+ \$3::float8 \* interval '1 second'\) ON CONFLICT \(key\) DO UPDATE SET value = CASE WHEN omni_kv\.expires_at IS NOT NULL AND omni_kv\.expires_at <= now\(\) THEN EXCLUDED\.value ELSE \(omni_kv\.value::bigint \+ \$2::bigint\)::text END, expires_at = CASE WHEN omni_kv\.expires_at IS NOT NULL AND omni_kv\.expires_at <= now\(\) THEN EXCLUDED\.expires_at ELSE omni_kv\.expires_at END RETURNING value$/;
const CLEANUP_SQL = /^DELETE FROM omni_kv WHERE expires_at IS NOT NULL AND expires_at <= now\(\)$/;

/**
 * In-memory Postgres stand-in for the KV table. Pattern-matches the adapter's
 * exact SQL and implements its upsert/expiry semantics on a Map with an
 * advanceable clock; any unrecognized statement throws.
 *
 * Matching the literal SQL is deliberate: it means a change to a statement
 * fails these tests loudly rather than passing against a lenient fake. The real
 * semantics are covered against a real server in `integration.test.ts`.
 */
export class FakeKvPool implements PgPoolLike {
  readonly rows = new Map<string, Row>();
  cleanupRuns = 0;
  endCalls = 0;
  private nowMs = 0;

  advance(seconds: number): void {
    this.nowMs += seconds * 1000;
  }

  async query(text: string, values: unknown[] = []): Promise<PgQueryResult> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (SELECT_SQL.test(sql)) {
      const row = this.rows.get(values[0] as string);
      if (row === undefined || this.expired(row)) return { rows: [] };
      return { rows: [{ value: row.value }] };
    }

    if (PUT_SQL.test(sql)) {
      const [key, value, ttl] = values as [string, string, number | null];
      this.rows.set(key, { value, expiresAt: ttl === null ? null : this.nowMs + ttl * 1000 });
      return { rows: [] };
    }

    if (DELETE_SQL.test(sql)) {
      this.rows.delete(values[0] as string);
      return { rows: [] };
    }

    if (INCREMENT_SQL.test(sql)) {
      const [key, amountText, ttl] = values as [string, string, number];
      const fresh: Row = { value: amountText, expiresAt: this.nowMs + ttl * 1000 };
      const existing = this.rows.get(key);
      // ON CONFLICT semantics: a physically present but expired row resets to
      // the insert values; a live row accumulates and keeps its expiry.
      const row =
        existing === undefined || this.expired(existing)
          ? fresh
          : {
              value: String(BigInt(existing.value) + BigInt(amountText)),
              expiresAt: existing.expiresAt,
            };
      this.rows.set(key, row);
      return { rows: [{ value: row.value }] };
    }

    if (CLEANUP_SQL.test(sql)) {
      this.cleanupRuns += 1;
      for (const [key, row] of this.rows) {
        if (this.expired(row)) this.rows.delete(key);
      }
      return { rows: [] };
    }

    throw new Error(`FakeKvPool: unrecognized SQL: ${sql}`);
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }

  private expired(row: Row): boolean {
    return row.expiresAt !== null && row.expiresAt <= this.nowMs;
  }
}

export interface MigrationPoolOptions {
  /** Versions already recorded in `omni_migrations`. */
  applied?: number[];
  /** Throw when a statement contains this substring, to exercise rollback. */
  failOn?: string;
  /** Fail `connect()` itself. */
  connectError?: Error;
}

/**
 * Records every statement a migration run issues, and simulates just the ledger
 * (`omni_migrations`) rather than a SQL engine. That keeps the runner's logic —
 * lock ordering, which versions are pending, transaction framing, rollback —
 * testable offline; whether the DDL is *valid* is a question only a real server
 * can answer, so `integration.test.ts` covers that.
 */
export class MigrationRecordingPool implements PgPoolLike {
  readonly statements: string[] = [];
  readonly ledger: Set<number>;
  connectCalls = 0;
  releaseCalls = 0;
  private readonly failOn: string | undefined;
  private readonly connectError: Error | undefined;

  constructor(options: MigrationPoolOptions = {}) {
    this.ledger = new Set(options.applied ?? []);
    this.failOn = options.failOn;
    this.connectError = options.connectError;
  }

  /** Statements with whitespace collapsed, for readable assertions. */
  get normalized(): string[] {
    return this.statements.map((sql) => sql.replace(/\s+/g, " ").trim());
  }

  async query(text: string, values?: unknown[]): Promise<PgQueryResult> {
    return this.run(text, values);
  }

  async connect(): Promise<PgClientLike> {
    this.connectCalls += 1;
    if (this.connectError !== undefined) throw this.connectError;
    return {
      query: (text: string, values?: unknown[]) => this.run(text, values),
      release: () => {
        this.releaseCalls += 1;
      },
    };
  }

  private async run(text: string, values?: unknown[]): Promise<PgQueryResult> {
    this.statements.push(text);
    if (this.failOn !== undefined && text.includes(this.failOn)) {
      throw new Error(`simulated failure on: ${this.failOn}`);
    }
    if (text.startsWith("SELECT version FROM omni_migrations")) {
      return { rows: [...this.ledger].map((version) => ({ version })) };
    }
    if (text.startsWith("INSERT INTO omni_migrations")) {
      this.ledger.add(Number((values ?? [])[0]));
      return { rows: [] };
    }
    return { rows: [] };
  }
}
