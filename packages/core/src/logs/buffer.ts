import type { Logger } from "../types.js";
import type { RequestLogEntry, RequestLogSink, RequestLogWriter } from "./types.js";

/** Entries per INSERT. Large enough to amortise a round trip, small enough to stay quick. */
const DEFAULT_BATCH_SIZE = 50;

/** How long a partial batch waits before being written anyway. */
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;

/**
 * Queue ceiling. Reached only when the database cannot keep up, at which point
 * dropping is the correct behaviour — the alternative is growing until the
 * process dies.
 */
const DEFAULT_MAX_QUEUE = 10_000;

export interface BufferedRequestLogSinkOptions {
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueue?: number;
  logger?: Logger;
}

/**
 * Buffers request logs and writes them in batches.
 *
 * Two properties matter more than throughput:
 *
 * - **`record` never throws and never awaits.** A logging failure must not
 *   become a request failure; the same fail-open rule rate limiting follows.
 * - **The queue is bounded.** Under a database outage the proxy keeps serving,
 *   so entries would otherwise accumulate without limit. Oldest are dropped
 *   first (newest observations are the useful ones) and counted, so the loss is
 *   visible rather than silent.
 */
export class BufferedRequestLogSink implements RequestLogSink {
  readonly type: string;
  /** Entries discarded because the queue was full or a write failed. */
  dropped = 0;
  written = 0;

  private readonly writer: RequestLogWriter;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueue: number;
  private readonly log: Logger | undefined;
  private queue: RequestLogEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Serialises writes so batches cannot interleave or overlap. */
  private draining: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(writer: RequestLogWriter, options: BufferedRequestLogSinkOptions = {}) {
    this.writer = writer;
    this.type = "buffered";
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.log = options.logger;
  }

  record(entry: RequestLogEntry): void {
    if (this.closed) return;
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.dropped += 1;
      // One line per drop would itself become the outage; report on flush instead.
      if (this.dropped === 1 || this.dropped % 1000 === 0) {
        this.log?.warn("request log queue is full; dropping oldest entries", {
          dropped: this.dropped,
          queued: this.queue.length,
        });
      }
    }
    this.queue.push(entry);

    if (this.queue.length >= this.batchSize) {
      void this.drain();
      return;
    }
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    this.clearTimer();
    await this.drain();
    // A batch can be queued while the previous one is in flight.
    if (this.queue.length > 0) await this.drain();
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    this.clearTimer();
    await this.writer.close?.();
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.flushIntervalMs);
    // Never keep the process alive just to flush logs.
    this.timer.unref?.();
  }

  /** Write queued entries, one batch at a time. Never rejects. */
  private drain(): Promise<void> {
    this.draining = this.draining.then(async () => {
      if (this.queue.length === 0) return;
      const batch = this.queue.splice(0, this.batchSize);
      try {
        await this.writer.write(batch);
        this.written += batch.length;
      } catch (error) {
        // Fail open: the batch is lost, the proxy is unaffected. Retrying would
        // risk unbounded growth during exactly the outage that caused this.
        this.dropped += batch.length;
        this.log?.error("writing request logs failed; entries dropped", {
          count: batch.length,
          dropped: this.dropped,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.queue.length > 0) this.scheduleFlush();
    });
    return this.draining;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** In-memory {@link RequestLogWriter} for tests and development. */
export class MemoryRequestLogWriter implements RequestLogWriter {
  readonly entries: RequestLogEntry[] = [];
  /** Set to make writes fail, to exercise the drop path. */
  failWith: Error | undefined;
  batches = 0;

  async write(entries: readonly RequestLogEntry[]): Promise<void> {
    if (this.failWith !== undefined) throw this.failWith;
    this.batches += 1;
    this.entries.push(...entries);
  }
}

/** Convenience: a buffered sink over in-memory storage. */
export function createMemoryRequestLogSink(
  options: BufferedRequestLogSinkOptions = {},
): BufferedRequestLogSink & { writer: MemoryRequestLogWriter } {
  const writer = new MemoryRequestLogWriter();
  const sink = new BufferedRequestLogSink(writer, options);
  return Object.assign(sink, { writer });
}
