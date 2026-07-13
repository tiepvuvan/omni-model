/** A single server-sent event. */
export interface SSEMessage {
  event: string | null;
  data: string;
  id: string | null;
}

/**
 * Incremental SSE parser. Feed decoded text as it arrives; complete events
 * are returned as they terminate. Handles `\r\n` / `\r` line endings and
 * events split across chunk boundaries.
 */
export class SSEParser {
  private buffer = "";
  private carry = "";

  feed(text: string): SSEMessage[] {
    let incoming = this.carry + text;
    this.carry = "";
    // Hold back a trailing "\r" so a "\r\n" split across chunks stays one break.
    if (incoming.endsWith("\r")) {
      this.carry = "\r";
      incoming = incoming.slice(0, -1);
    }
    this.buffer += incoming.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    const messages: SSEMessage[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const message = parseEventBlock(block);
      if (message !== null) messages.push(message);
      boundary = this.buffer.indexOf("\n\n");
    }
    return messages;
  }

  /** Parse whatever remains in the buffer as a final, unterminated event. */
  flush(): SSEMessage | null {
    const block = this.buffer + this.carry;
    this.buffer = "";
    this.carry = "";
    return parseEventBlock(block);
  }
}

function parseEventBlock(block: string): SSEMessage | null {
  let event: string | null = null;
  let id: string | null = null;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (event === null && id === null && data.length === 0) return null;
  return { event, data: data.join("\n"), id };
}

/** Iterate the SSE events of a byte stream. */
export async function* readSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEMessage, void, undefined> {
  const parser = new SSEParser();
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const message of parser.feed(decoder.decode(value, { stream: true }))) {
        yield message;
      }
    }
    for (const message of parser.feed(decoder.decode())) yield message;
    const remainder = parser.flush();
    if (remainder !== null) yield remainder;
  } finally {
    reader.releaseLock();
  }
}

const encoder = new TextEncoder();

export function encodeSSEData(data: string): Uint8Array {
  return encoder.encode(`data: ${data}\n\n`);
}

/**
 * Build an OpenAI-style SSE byte stream — `data: <json>` per chunk, then
 * `data: [DONE]` — from an async iterable of JSON-serializable chunks.
 * Cancelling the stream stops the underlying iterator.
 */
export function sseStreamFromChunks<T>(chunks: AsyncIterable<T>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.enqueue(encodeSSEData("[DONE]"));
        controller.close();
        return;
      }
      controller.enqueue(encodeSSEData(JSON.stringify(value)));
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}

/**
 * Pass a byte stream through unchanged while observing its SSE events.
 * `onEnd` fires exactly once, after the source stream finishes.
 */
export function observeSSEStream(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: SSEMessage) => void,
  onEnd?: () => void,
): ReadableStream<Uint8Array> {
  const parser = new SSEParser();
  const decoder = new TextDecoder();
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        for (const message of parser.feed(decoder.decode(chunk, { stream: true }))) {
          onMessage(message);
        }
      },
      flush() {
        for (const message of parser.feed(decoder.decode())) onMessage(message);
        const remainder = parser.flush();
        if (remainder !== null) onMessage(remainder);
        onEnd?.();
      },
    }),
  );
}
