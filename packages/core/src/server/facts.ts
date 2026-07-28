import type { Identity } from "../auth/types.js";
import type { ChatCompletionRequest } from "../openai/types.js";
import type { RequestFacts } from "../routing/types.js";
import { estimateInputTokens } from "../util/input-tokens.js";
import type { WriteKey } from "../writekeys/types.js";

/**
 * Header names that must never reach CEL expressions (or logs) verbatim, in
 * addition to the pattern check in {@link isRedactedHeader}. They stay present
 * as `<redacted>` so expressions can still test existence.
 */
const REDACTED_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  // Firebase App Check + Apple DeviceCheck / App Attest credential headers.
  "x-firebase-appcheck",
  "x-apple-device-token",
  "x-appattest-assertion",
  "x-appattest-keyid",
  "x-appattest-challenge",
]);

/** Substrings that mark a header (lowercased name) as credential-bearing. */
const REDACTED_HEADER_PATTERNS = ["token", "appcheck", "assertion", "api-key", "-key"];

/**
 * Whether a (lowercased) header name carries a credential and must be redacted
 * before it reaches CEL expressions or logs. Covers the fixed set above plus
 * any custom verifier header whose name looks token-like.
 */
function isRedactedHeader(name: string): boolean {
  if (REDACTED_HEADERS.has(name)) return true;
  return REDACTED_HEADER_PATTERNS.some((pattern) => name.includes(pattern));
}

/**
 * Best-effort client IP.
 *
 * When `trustProxyHeaders` is true (the proxy runs behind a trusted reverse
 * proxy / CDN), honor `cf-connecting-ip` (set by Cloudflare's CDN, which many
 * container deployments still sit behind), then the first (client-most) entry
 * of `x-forwarded-for`, then `x-real-ip`.
 *
 * When it is false, these headers are client-suppliable and therefore
 * untrusted: they are ignored entirely (returns `null`) so a client cannot
 * spoof its rate-limit key. The connection-level IP, when available, is
 * supplied by the platform via the `clientIp` resolver rather than here.
 */
export function extractClientIp(headers: Headers, trustProxyHeaders: boolean): string | null {
  if (!trustProxyHeaders) return null;
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
  /** The calling application's write key, when one was presented. */
  writeKey: WriteKey | null;
  /** Override used only for an operator's hypothetical routing simulation. */
  inputTokenCount?: number;
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

  const headers: Record<string, string> = {};
  input.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    headers[name] = isRedactedHeader(name) ? "<redacted>" : value;
  });

  return {
    request: {
      model: typeof body.model === "string" ? body.model : "",
      inputTokenCount:
        input.inputTokenCount ?? (input.body === null ? 0 : estimateInputTokens(input.body)),
      maxTokens:
        finiteNumberOrNull(body.max_completion_tokens) ?? finiteNumberOrNull(body.max_tokens),
      temperature: finiteNumberOrNull(body.temperature),
    },
    user: {
      id: input.identity?.userId ?? null,
      claims: input.identity?.claims ?? {},
      providers:
        input.identity === null ? [] : (input.identity.providers ?? [input.identity.provider]),
    },
    client: {
      id: input.writeKey?.id ?? null,
      name: input.writeKey?.name ?? null,
    },
    http: { method: input.method, path: input.path, ip: input.ip, headers },
  };
}
