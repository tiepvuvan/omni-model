import { jwtVerify } from "jose";
import { z } from "zod";
import { ConfigError } from "../../errors.js";
import type { RuntimeContext } from "../../types.js";
import type { AuthResult, AuthVerifier, AuthVerifierFactory } from "../types.js";
import { extractToken, invalidTokenResult, isInvalidTokenError, remoteJwks } from "./token.js";

const TYPE = "clerk";
const httpsUrl = z
  .url()
  .refine((value) => new URL(value).protocol === "https:", "must use an https URL");

const optionsSchema = z.strictObject({
  type: z.literal(TYPE).optional(),
  name: z.string().optional(),
  /** Frontend API URL from the Clerk instance; this is the session-token issuer. */
  issuer: httpsUrl,
  /** Explicit JWKS endpoint; defaults to `<issuer>/.well-known/jwks.json`. */
  jwksUrl: httpsUrl.optional(),
  /** Allowed `azp` origins, protecting against leaked cross-subdomain cookies. */
  authorizedParties: z.array(z.string().min(1)).min(1).optional(),
  /** Optional JWT audience allowlist for customized session tokens. */
  audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  /** Reject Clerk organization sessions whose `sts` claim is `pending`. */
  allowPendingSessions: z.boolean().default(false),
  /** Header carrying the session token as `Bearer <token>`. */
  header: z.string().min(1).default("authorization"),
  clockToleranceSeconds: z.number().int().nonnegative().default(5),
});

function unavailable(error: unknown): AuthResult {
  return isInvalidTokenError(error)
    ? invalidTokenResult(error)
    : { ok: false, status: 503, reason: "Clerk verification unavailable" };
}

/**
 * Verifies Clerk session tokens against the instance's Frontend API JWKS.
 * The Clerk user id (`sub`) becomes `identity.userId`; all verified session
 * and organization claims remain available to routing and rate-limit CEL.
 */
export const clerkVerifierFactory: AuthVerifierFactory = {
  type: TYPE,
  layer: "user",
  optionsSchema,
  create(options: Record<string, unknown>, runtime: RuntimeContext): AuthVerifier {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ConfigError(
        `invalid "${TYPE}" verifier options:\n${z.prettifyError(parsed.error)}`,
      );
    }
    const opts = parsed.data;
    const issuer = opts.issuer.replace(/\/+$/, "");
    const jwks = remoteJwks(opts.jwksUrl ?? `${issuer}/.well-known/jwks.json`, runtime);

    return {
      type: TYPE,
      name: opts.name ?? TYPE,
      async verify(request, ctx): Promise<AuthResult | null> {
        const token = extractToken(request, opts.header, "bearer");
        if (token === null) return null;
        try {
          const { payload } = await jwtVerify(token, jwks, {
            algorithms: ["RS256"],
            issuer,
            audience: opts.audience,
            typ: "JWT",
            clockTolerance: opts.clockToleranceSeconds,
            currentDate: new Date(ctx.now()),
          });
          if (typeof payload.sub !== "string" || payload.sub === "") {
            return { ok: false, reason: "Clerk token has no user subject" };
          }
          if (typeof payload.sid !== "string" || payload.sid === "") {
            return { ok: false, reason: "Clerk token has no session id" };
          }
          if (opts.authorizedParties !== undefined && payload.azp !== undefined) {
            if (typeof payload.azp !== "string" || !opts.authorizedParties.includes(payload.azp)) {
              return { ok: false, reason: "Clerk token authorized party is not allowed" };
            }
          }
          if (!opts.allowPendingSessions && payload.sts === "pending") {
            return { ok: false, reason: "Clerk session is pending" };
          }
          return {
            ok: true,
            identity: { provider: TYPE, userId: payload.sub, claims: payload },
          };
        } catch (error) {
          return unavailable(error);
        }
      },
    };
  },
};
