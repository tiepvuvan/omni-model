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
  return captureJson(redactSensitiveFields(messages), maxBytes);
}

const SENSITIVE_FIELD =
  /authorization|cookie|credential|password|secret|signature|token|(?:^|[-_])(?:api[-_]?key|key)(?:$|[-_])/i;

function redactSensitiveFields(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => redactSensitiveFields(item, seen));
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SENSITIVE_FIELD.test(key) ? "[REDACTED]" : redactSensitiveFields(item, seen);
  }
  return redacted;
}

function captureJson(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  let serialized: string;
  try {
    serialized = JSON.stringify(value ?? null);
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

function isSafeDiagnosticHeader(name: string): boolean {
  return (
    /^(?:accept|accept-encoding|accept-language|connection|content-length|content-type|host|origin|referer|traceparent|tracestate|user-agent)$/i.test(
      name,
    ) || /^(?:sec-fetch-|x-forwarded-|x-real-ip$|x-request-|x-correlation-|x-trace-)/i.test(name)
  );
}

/**
 * Capture a parsed request body at the content cap.
 *
 * Credential-shaped fields are replaced before serialization, so a custom
 * OpenAI-compatible extension cannot smuggle an API key into request logs.
 */
export function captureRequestBody(
  body: unknown,
  maxBytes: number,
): { value: unknown; truncated: boolean } {
  return captureJson(redactSensitiveFields(body), maxBytes);
}

/**
 * Capture request headers at the content cap.
 *
 * Header names remain visible for diagnosis, while any name that could carry a
 * credential is retained only as `[REDACTED]`.
 */
export function captureRequestHeaders(
  headers: Headers,
  maxBytes: number,
): { value: Record<string, string>; truncated: boolean } {
  const captured: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    captured[name] =
      SENSITIVE_FIELD.test(name) || !isSafeDiagnosticHeader(name) ? "[REDACTED]" : value;
  }
  const result = captureJson(captured, maxBytes);
  return {
    value:
      typeof result.value === "object" && result.value !== null && !Array.isArray(result.value)
        ? (result.value as Record<string, string>)
        : { "[truncated]": String(result.value) },
    truncated: result.truncated,
  };
}
