import { describe, expect, it } from "vitest";
import { PostgresConfigStore } from "../src/config-store.js";
import type { PgClientLike, PgPoolLike, PgQueryResult } from "../src/pool.js";

describe("PostgresConfigStore lifecycle", () => {
  it("destroys a LISTEN connection that arrives after close", async () => {
    let finishConnect: ((client: PgClientLike) => void) | undefined;
    const connected = new Promise<PgClientLike>((resolve) => {
      finishConnect = resolve;
    });
    let releaseDestroy: boolean | undefined;
    let released: (() => void) | undefined;
    const releaseObserved = new Promise<void>((resolve) => {
      released = resolve;
    });
    const client: PgClientLike = {
      query: async (): Promise<PgQueryResult> => ({ rows: [] }),
      release: (destroy) => {
        releaseDestroy = destroy;
        released?.();
      },
      on: () => {},
    };
    const pool: PgPoolLike = {
      query: async (): Promise<PgQueryResult> => ({ rows: [] }),
      connect: async () => connected,
    };
    const store = new PostgresConfigStore(pool, { pollIntervalMs: 60_000 });

    const unwatch = store.watch(() => {});
    const closing = store.close();
    finishConnect?.(client);
    await closing;
    await releaseObserved;
    unwatch();

    expect(releaseDestroy).toBe(true);
  });

  it("destroys a checked-out client when close races with the LISTEN query", async () => {
    let finishListen: (() => void) | undefined;
    const listening = new Promise<void>((resolve) => {
      finishListen = resolve;
    });
    let markStarted: (() => void) | undefined;
    const queryStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let released = false;
    let markReleased: (() => void) | undefined;
    const releaseObserved = new Promise<void>((resolve) => {
      markReleased = resolve;
    });
    const client: PgClientLike = {
      query: async () => {
        markStarted?.();
        await listening;
        return { rows: [] };
      },
      release: (destroy) => {
        released = destroy === true;
        finishListen?.();
        markReleased?.();
      },
      on: () => {},
    };
    const pool: PgPoolLike = {
      query: async (): Promise<PgQueryResult> => ({ rows: [] }),
      connect: async () => client,
    };
    const store = new PostgresConfigStore(pool, { pollIntervalMs: 60_000 });

    store.watch(() => {});
    await queryStarted;
    const closing = store.close();

    await releaseObserved;
    await closing;
    expect(released).toBe(true);
  });
});
