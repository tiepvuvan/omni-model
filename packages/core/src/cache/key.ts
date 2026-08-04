/**
 * What makes two requests the same request.
 *
 * A cache hit has to be indistinguishable from a fresh call, so the key covers
 * everything that could change the answer:
 *
 * - **The resolved upstream and model.** Two routing rules can serve the same
 *   client-facing model name from different providers; sharing an entry between
 *   them would answer with the wrong model's output.
 * - **The whole request body**, canonicalised. Not just the messages: `temperature`,
 *   `tools`, `response_format` and everything else change the answer, and a body
 *   the proxy does not understand changes it too — unknown fields pass through to
 *   the upstream, so they belong in the key.
 * - **Whether the client streams.** A stored answer is replayed in the shape it was
 *   captured in, so the two shapes are separate entries rather than one that has to
 *   be converted.
 *
 * `user` is deliberately *not* in the key. The body is, and OpenAI's `user` field
 * lives in it — so a caller who sends it gets a per-user cache, and one who does
 * not gets a deployment-wide one. Worth knowing which you have: a shared entry
 * means one user's completion is served to another for the same prompt, which is
 * the point of a cache and also a decision about your users' data.
 */

/** Stable JSON: object keys sorted at every depth, so key order cannot change the hash. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The cache key for one request against one resolved target.
 *
 * SHA-256 over the canonical form. WebCrypto rather than a hand-rolled hash: it is
 * available everywhere core runs, and a weak hash here is a way to serve one
 * prompt's answer to a different prompt.
 */
export async function promptCacheKey(input: {
  /** Named provider instance. Falls back to `providerType` for legacy callers. */
  providerId?: string;
  /** Provider type the router chose, e.g. `openai`. */
  providerType: string;
  /** Routing rule the request matched. */
  routeName: string;
  /** Model the upstream will actually be asked for. */
  model: string;
  /** The client's request body, verbatim. */
  body: unknown;
  stream: boolean;
  /** `chat` or `embeddings` — two endpoints, two answer shapes. */
  endpoint: "chat" | "embeddings";
}): Promise<string> {
  const source = canonical({
    endpoint: input.endpoint,
    providerId: input.providerId ?? input.providerType,
    providerType: input.providerType,
    routeName: input.routeName,
    model: input.model,
    stream: input.stream,
    body: input.body,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return hex(digest);
}
