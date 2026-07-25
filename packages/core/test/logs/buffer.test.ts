import { describe, expect, it, vi } from "vitest";
import { BufferedRequestLogSink, MemoryRequestLogWriter } from "../../src/logs/buffer.js";
import type { RequestLogEntry } from "../../src/logs/types.js";
import { createRecordingLogger } from "../server/helpers.js";

function entry(requestId: string): RequestLogEntry {
  return {
    requestId,
    ts: 1000,
    writeKeyId: null,
    userId: null,
    deviceId: null,
    authProvider: null,
    modelRequested: "m",
    modelRouted: "m",
    providerId: "p",
    routeName: null,
    stream: false,
    status: 200,
    errorCode: null,
    rateLimitRule: null,
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    latencyMs: 5,
    ttfbMs: null,
    ip: null,
    userAgent: null,
  };
}

describe("BufferedRequestLogSink", () => {
  it("writes a full batch without waiting for the timer", async () => {
    const writer = new MemoryRequestLogWriter();
    const sink = new BufferedRequestLogSink(writer, { batchSize: 3, flushIntervalMs: 60_000 });

    sink.record(entry("a"));
    sink.record(entry("b"));
    expect(writer.entries).toHaveLength(0);
    sink.record(entry("c"));
    await sink.flush();

    expect(writer.entries.map((e) => e.requestId)).toEqual(["a", "b", "c"]);
    expect(writer.batches).toBe(1);
  });

  it("flushes a partial batch on the timer", async () => {
    vi.useFakeTimers();
    try {
      const writer = new MemoryRequestLogWriter();
      const sink = new BufferedRequestLogSink(writer, { batchSize: 100, flushIntervalMs: 500 });
      sink.record(entry("a"));

      expect(writer.entries).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(600);

      expect(writer.entries).toHaveLength(1);
      await sink.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("record never throws, even when the writer is broken", async () => {
    // The contract that keeps logging from becoming an outage.
    const writer = new MemoryRequestLogWriter();
    writer.failWith = new Error("database is down");
    const { logger, entries } = createRecordingLogger();
    const sink = new BufferedRequestLogSink(writer, { batchSize: 1, logger });

    expect(() => sink.record(entry("a"))).not.toThrow();
    await expect(sink.flush()).resolves.toBeUndefined();

    expect(sink.dropped).toBe(1);
    expect(writer.entries).toHaveLength(0);
    expect(entries.some((line) => line.message.includes("dropped"))).toBe(true);
  });

  it("recovers once the writer works again", async () => {
    const writer = new MemoryRequestLogWriter();
    writer.failWith = new Error("down");
    const sink = new BufferedRequestLogSink(writer, { batchSize: 1 });

    sink.record(entry("lost"));
    await sink.flush();
    writer.failWith = undefined;
    sink.record(entry("kept"));
    await sink.flush();

    expect(writer.entries.map((e) => e.requestId)).toEqual(["kept"]);
    expect(sink.dropped).toBe(1);
    expect(sink.written).toBe(1);
  });

  it("bounds the queue and drops oldest first", async () => {
    // Under a database outage the proxy keeps serving, so an unbounded queue
    // would grow until the process died. Newest observations are the useful ones.
    const writer = new MemoryRequestLogWriter();
    writer.failWith = new Error("down");
    const { logger } = createRecordingLogger();
    const sink = new BufferedRequestLogSink(writer, {
      batchSize: 1000,
      flushIntervalMs: 60_000,
      maxQueue: 5,
      logger,
    });

    for (let i = 0; i < 50; i += 1) sink.record(entry(`e${i}`));

    expect(sink.dropped).toBe(45);
    writer.failWith = undefined;
    await sink.flush();
    // The five survivors are the five newest.
    expect(writer.entries.map((e) => e.requestId)).toEqual(["e45", "e46", "e47", "e48", "e49"]);
  });

  it("flush drains everything queued, across batches", async () => {
    const writer = new MemoryRequestLogWriter();
    const sink = new BufferedRequestLogSink(writer, { batchSize: 2, flushIntervalMs: 60_000 });
    for (let i = 0; i < 5; i += 1) sink.record(entry(`e${i}`));

    await sink.flush();

    expect(writer.entries).toHaveLength(5);
  });

  it("ignores records after close, so a shutdown cannot be extended forever", async () => {
    const writer = new MemoryRequestLogWriter();
    const sink = new BufferedRequestLogSink(writer, { batchSize: 1 });
    await sink.close();

    sink.record(entry("late"));
    await sink.flush();

    expect(writer.entries).toHaveLength(0);
  });
});
