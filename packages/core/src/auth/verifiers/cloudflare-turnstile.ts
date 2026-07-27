import { z } from "zod";
import { ConfigError } from "../../errors.js";
import type { RuntimeContext } from "../../types.js";
import type { AuthResult, AuthVerifier, AuthVerifierFactory, VerifyContext } from "../types.js";

const TYPE = "cloudflare-turnstile";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2048;

const optionsSchema = z.strictObject({
  type: z.literal(TYPE).optional(),
  name: z.string().optional(),
  /** Turnstile widget secret, used only by the server-side Siteverify call. */
  secret: z.string().min(1),
  /** Header carrying a fresh Turnstile response token. */
  header: z.string().min(1).default("x-turnstile-token"),
  /** Require the widget action returned by Siteverify to equal this value. */
  action: z.string().min(1).optional(),
  /** Optional allowlist for the hostname returned by Siteverify. */
  hostnames: z.array(z.string().min(1)).min(1).optional(),
});

interface TurnstileResponse {
  success: boolean;
  challengeTs?: string;
  hostname?: string;
  action?: string;
  errorCodes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResponse(value: unknown): TurnstileResponse | null {
  if (!isRecord(value) || typeof value.success !== "boolean") return null;
  const errorCodes = value["error-codes"];
  return {
    success: value.success,
    ...(typeof value.challenge_ts === "string" ? { challengeTs: value.challenge_ts } : {}),
    ...(typeof value.hostname === "string" ? { hostname: value.hostname } : {}),
    ...(typeof value.action === "string" ? { action: value.action } : {}),
    errorCodes: Array.isArray(errorCodes)
      ? errorCodes.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

async function verifyUpstream(
  token: string,
  secret: string,
  ctx: VerifyContext,
): Promise<TurnstileResponse | null> {
  const idempotencyKey = crypto.randomUUID();
  const body = {
    secret,
    response: token,
    idempotency_key: idempotencyKey,
    ...(ctx.clientIp === undefined || ctx.clientIp === null ? {} : { remoteip: ctx.clientIp }),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await ctx.fetch(SITEVERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        if (attempt === 0 && response.status >= 500) continue;
        return null;
      }
      const parsed = parseResponse(await response.json().catch(() => null));
      if (parsed === null && attempt === 0) continue;
      return parsed;
    } catch {
      if (attempt === 1) return null;
    }
  }
  return null;
}

function unavailable(): AuthResult {
  return { ok: false, status: 503, reason: "Turnstile verification unavailable" };
}

/**
 * Verifies a fresh Cloudflare Turnstile token through the mandatory server-side
 * Siteverify endpoint. Tokens are not cached because Turnstile makes them
 * single-use; one idempotent retry recovers a lost transient response safely.
 */
export const cloudflareTurnstileVerifierFactory: AuthVerifierFactory = {
  type: TYPE,
  layer: "app",
  optionsSchema,
  create(options: Record<string, unknown>, _runtime: RuntimeContext): AuthVerifier {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ConfigError(
        `invalid "${TYPE}" verifier options:\n${z.prettifyError(parsed.error)}`,
      );
    }
    const opts = parsed.data;

    return {
      type: TYPE,
      name: opts.name ?? TYPE,
      async verify(request, ctx): Promise<AuthResult | null> {
        const token = request.headers.get(opts.header);
        if (token === null || token === "") return null;
        if (token.length > MAX_TOKEN_LENGTH) {
          return { ok: false, reason: "Turnstile token is invalid" };
        }

        const result = await verifyUpstream(token, opts.secret, ctx);
        if (result === null) return unavailable();
        if (!result.success) {
          if (
            result.errorCodes.includes("invalid-input-secret") ||
            result.errorCodes.includes("missing-input-secret") ||
            result.errorCodes.includes("internal-error")
          ) {
            return unavailable();
          }
          return { ok: false, reason: "Turnstile token was rejected" };
        }
        if (opts.action !== undefined && result.action !== opts.action) {
          return { ok: false, reason: "Turnstile action does not match" };
        }
        if (
          opts.hostnames !== undefined &&
          (result.hostname === undefined || !opts.hostnames.includes(result.hostname))
        ) {
          return { ok: false, reason: "Turnstile hostname is not allowed" };
        }

        return {
          ok: true,
          identity: {
            provider: TYPE,
            claims: {
              ...(result.challengeTs === undefined ? {} : { challengeTime: result.challengeTs }),
              ...(result.hostname === undefined ? {} : { hostname: result.hostname }),
              ...(result.action === undefined ? {} : { action: result.action }),
            },
          },
        };
      },
    };
  },
};
