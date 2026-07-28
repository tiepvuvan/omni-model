import { jwtVerify } from "jose";
import { z } from "zod";
import { ConfigError } from "../../errors.js";
import type { RuntimeContext } from "../../types.js";
import type { AuthResult, AuthVerifier, AuthVerifierFactory } from "../types.js";
import { extractToken, invalidTokenResult, isInvalidTokenError, remoteJwks } from "./token.js";

const TYPE = "aws-cognito";

const optionsSchema = z
  .strictObject({
    type: z.literal(TYPE).optional(),
    name: z.string().optional(),
    /** AWS region containing the user pool, e.g. `us-east-1`. */
    region: z.string().regex(/^[a-z0-9-]+$/, "region must be an AWS region name"),
    /** Cognito user pool id, including its region prefix. */
    userPoolId: z.string().min(1),
    /** App client ids accepted through `client_id` (access) or `aud` (ID). */
    clientIds: z.array(z.string().min(1)).min(1),
    /** Which Cognito user-pool token kind this API accepts. */
    tokenUse: z.enum(["access", "id", "either"]).default("access"),
    /** OAuth scopes that every accepted access token must contain. */
    requiredScopes: z.array(z.string().min(1)).min(1).optional(),
    /** Header carrying the token. Authorization is reserved for publishable keys. */
    header: z.string().min(1).default("x-cognito-id-token"),
    /** "bearer" strips a `Bearer ` prefix; "none" uses the raw header value. */
    scheme: z.enum(["bearer", "none"]).default("none"),
    clockToleranceSeconds: z.number().int().nonnegative().default(60),
  })
  .superRefine((options, issues) => {
    if (!options.userPoolId.startsWith(`${options.region}_`)) {
      issues.addIssue({
        code: "custom",
        path: ["userPoolId"],
        message: "userPoolId must start with the configured region followed by an underscore",
      });
    }
    if (options.tokenUse === "id" && options.requiredScopes !== undefined) {
      issues.addIssue({
        code: "custom",
        path: ["requiredScopes"],
        message: "requiredScopes can only be enforced for access tokens",
      });
    }
  });

function audienceMatches(audience: unknown, clientIds: readonly string[]): boolean {
  if (typeof audience === "string") return clientIds.includes(audience);
  return Array.isArray(audience)
    ? audience.some((entry) => typeof entry === "string" && clientIds.includes(entry))
    : false;
}

function scopesInclude(scope: unknown, required: readonly string[]): boolean {
  if (typeof scope !== "string") return false;
  const granted = new Set(scope.split(/\s+/).filter((entry) => entry !== ""));
  return required.every((entry) => granted.has(entry));
}

function unavailable(error: unknown): AuthResult {
  return isInvalidTokenError(error)
    ? invalidTokenResult(error)
    : { ok: false, status: 503, reason: "AWS Cognito verification unavailable" };
}

/**
 * Verifies Amazon Cognito user-pool access and ID tokens. It pins the pool
 * issuer, RS256 key set, token kind, and app client using Cognito's distinct
 * `client_id` (access token) and `aud` (ID token) claim conventions.
 */
export const awsCognitoVerifierFactory: AuthVerifierFactory = {
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
    const issuer = `https://cognito-idp.${opts.region}.amazonaws.com/${opts.userPoolId}`;
    const jwks = remoteJwks(`${issuer}/.well-known/jwks.json`, runtime);

    return {
      type: TYPE,
      name: opts.name ?? TYPE,
      async verify(request, ctx): Promise<AuthResult | null> {
        const token = extractToken(request, opts.header, opts.scheme);
        if (token === null) return null;
        try {
          const { payload } = await jwtVerify(token, jwks, {
            algorithms: ["RS256"],
            issuer,
            clockTolerance: opts.clockToleranceSeconds,
            currentDate: new Date(ctx.now()),
          });
          if (typeof payload.sub !== "string" || payload.sub === "") {
            return { ok: false, reason: "Cognito token has no user subject" };
          }
          const tokenUse = payload.token_use;
          if (tokenUse !== "access" && tokenUse !== "id") {
            return { ok: false, reason: "Cognito token_use is invalid" };
          }
          if (opts.tokenUse !== "either" && tokenUse !== opts.tokenUse) {
            return { ok: false, reason: `Cognito ${tokenUse} token is not accepted` };
          }
          if (
            tokenUse === "access" &&
            (typeof payload.client_id !== "string" || !opts.clientIds.includes(payload.client_id))
          ) {
            return { ok: false, reason: "Cognito access token client is not allowed" };
          }
          if (tokenUse === "id" && !audienceMatches(payload.aud, opts.clientIds)) {
            return { ok: false, reason: "Cognito ID token audience is not allowed" };
          }
          if (
            tokenUse === "access" &&
            opts.requiredScopes !== undefined &&
            !scopesInclude(payload.scope, opts.requiredScopes)
          ) {
            return { ok: false, reason: "Cognito access token is missing a required scope" };
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
