/**
 * Byte-capped text accumulator for captured content.
 *
 * A cap is not optional. A streamed completion has no size limit, and the whole
 * point of capture is that it happens on requests you have not inspected yet —
 * so an unbounded buffer is an out-of-memory condition waiting for one verbose
 * response. Truncation is recorded so a reader knows the text is partial rather
 * than assuming the model stopped there.
 */
export class ContentAccumulator {
  private readonly maxBytes: number;
  private readonly parts: string[] = [];
  private bytes = 0;
  private cut = false;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  /** Append a delta, stopping at the cap. */
  push(text: string): void {
    if (this.cut || text === "") return;
    // Byte length, not string length: a cap in characters would let a
    // multi-byte-heavy response use several times the intended memory.
    const size = byteLength(text);
    if (this.bytes + size <= this.maxBytes) {
      this.parts.push(text);
      this.bytes += size;
      return;
    }
    const room = this.maxBytes - this.bytes;
    if (room > 0) this.parts.push(sliceToBytes(text, room));
    this.cut = true;
  }

  get truncated(): boolean {
    return this.cut;
  }

  /** Null when nothing was captured, so an empty completion is distinguishable. */
  text(): string | null {
    return this.parts.length === 0 ? null : this.parts.join("");
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Cut `text` to at most `maxBytes`, never splitting a character. */
function sliceToBytes(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text).subarray(0, maxBytes);
  // `fatal: false` replaces a trailing partial sequence rather than throwing;
  // dropping the replacement character keeps the stored text clean.
  return new TextDecoder("utf-8", { fatal: false }).decode(encoded).replace(/�$/, "");
}

/**
 * Capture a prompt, capped.
 *
 * Serialised and re-parsed so an oversized prompt is stored truncated rather
 * than rejected, and so the stored value can never share structure with the
 * live request object.
 */
export function capturePrompt(
  messages: unknown,
  maxBytes: number,
): { value: unknown; truncated: boolean } {
  let serialized: string;
  try {
    serialized = JSON.stringify(messages ?? null);
  } catch {
    // Circular or otherwise unserialisable: record that something was there.
    return { value: null, truncated: true };
  }
  if (byteLength(serialized) <= maxBytes) {
    return { value: JSON.parse(serialized) as unknown, truncated: false };
  }
  // Truncated JSON is not parseable, so store it as a string. A reader can still
  // see what the prompt began with, which is the point.
  return { value: sliceToBytes(serialized, maxBytes), truncated: true };
}
