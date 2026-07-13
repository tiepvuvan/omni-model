import { describe, expect, it } from "vitest";
import { readSSEStream, sseStreamFromChunks } from "../../src/util/sse.js";

const encoder = new TextEncoder();

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

/** A stream that emits `parts`, then stays open (never closes) until cancelled. */
function quietAfter(parts: string[]): {
  stream: ReadableStream<Uint8Array>;
  cancelled: Promise<void>;
} {
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      // Intentionally does not close: models an upstream that goes silent.
    },
    cancel() {
      resolveCancelled();
    },
  });
  return { stream, cancelled };
}

describe("readSSEStream", () => {
  it("yields complete events across chunk boundaries", async () => {
    const stream = streamOf(["data: a\n", "\ndata: b\n\n"]);
    const messages = [];
    for await (const message of readSSEStream(stream)) messages.push(message.data);
    expect(messages).toEqual(["a", "b"]);
  });

  it("cancels the reader and completes when the signal aborts during a quiet read", async () => {
    const { stream, cancelled } = quietAfter(["data: first\n\n"]);
    const controller = new AbortController();
    const seen: string[] = [];
    const consume = (async () => {
      for await (const message of readSSEStream(stream, { signal: controller.signal })) {
        seen.push(message.data);
        // After the first event the upstream is silent; abort mid-read.
        controller.abort();
      }
    })();
    // If abort did not unblock the read, this would hang and time out.
    await consume;
    await cancelled;
    expect(seen).toEqual(["first"]);
  });

  it("ends immediately when handed an already-aborted signal", async () => {
    const { stream, cancelled } = quietAfter([]);
    const controller = new AbortController();
    controller.abort();
    const seen: string[] = [];
    for await (const message of readSSEStream(stream, { signal: controller.signal })) {
      seen.push(message.data);
    }
    await cancelled;
    expect(seen).toEqual([]);
  });
});

describe("sseStreamFromChunks", () => {
  it("emits data lines then [DONE]", async () => {
    const stream = sseStreamFromChunks(
      (async function* () {
        yield { a: 1 };
        yield { b: 2 };
      })(),
    );
    const text = await new Response(stream).text();
    expect(text).toBe('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n');
  });

  it("invokes onCancel and returns the iterator when the stream is cancelled", async () => {
    let onCancelCalled = false;
    let iteratorReturned = false;
    const chunks = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: { tick: 1 } };
          },
          async return() {
            iteratorReturned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const stream = sseStreamFromChunks(chunks, {
      onCancel: () => {
        onCancelCalled = true;
      },
    });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(onCancelCalled).toBe(true);
    expect(iteratorReturned).toBe(true);
  });
});
