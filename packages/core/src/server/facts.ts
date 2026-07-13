import type { Identity } from "../auth/types.js";
import type { ChatCompletionRequest } from "../openai/types.js";
import type { RequestFacts } from "../routing/types.js";

/**
 * Header values that must never reach CEL expressions (or logs) verbatim.
 * They stay present as `<redacted>` so expressions can still test existence.
 */
const REDACTED_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-api-key"]);

/**
 * Best-effort client IP: `cf-connecting-ip` (set by Cloudflare), then the
 * first (client-most) entry of `x-forwarded-for`, then `x-real-ip`.
 */
export function extractClientIp(headers: Headers): string | null {
  const cfIp = headers.get("cf-connecting-ip")?.trim();
  if (cfIp !== undefined && cfIp !== "") return cfIp;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp !== undefined && realIp !== "") return realIp;
  return null;
}

export interface RequestFactsInput {
  method: string;
  path: string;
  headers: Headers;
  ip: string | null;
  /** Parsed request body; embeddings requests only need `model`. */
  body: ChatCompletionRequest | { model?: string } | null;
  identity: Identity | null;
  /** Epoch milliseconds. */
  now: number;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Build the variables exposed to routing and rate-limit expressions from a
 * request. Sensitive headers are redacted (see `REDACTED_HEADERS`); header
 * names are lowercased.
 */
export function buildRequestFacts(input: RequestFactsInput): RequestFacts {
  const body = (input.body ?? {}) as Record<string, unknown>;
  const messages = body.messages;

  const headers: Record<string, string> = {};
  input.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    headers[name] = REDACTED_HEADERS.has(name) ? "<redacted>" : value;
  });

  return {
    request: {
      model: typeof body.model === "string" ? body.model : "",
      stream: body.stream === true,
      messageCount: Array.isArray(messages) ? messages.length : 0,
      maxTokens:
        finiteNumberOrNull(body.max_completion_tokens) ?? finiteNumberOrNull(body.max_tokens),
      temperature: finiteNumberOrNull(body.temperature),
      user: typeof body.user === "string" ? body.user : null,
    },
    user: {
      id: input.identity?.userId ?? null,
      authenticated: input.identity !== null,
      provider: input.identity?.provider ?? null,
      claims: input.identity?.claims ?? {},
    },
    device: { id: input.identity?.deviceId ?? null },
    http: { method: input.method, path: input.path, ip: input.ip, headers },
    now: input.now,
  };
}
