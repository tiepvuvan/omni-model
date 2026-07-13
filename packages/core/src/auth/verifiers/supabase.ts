import type { JWTPayload, JWTVerifyResult } from "jose";
import { jwtVerify } from "jose";
import { z } from "zod";
import { ConfigError } from "../../errors.js";
import type { RuntimeContext } from "../../types.js";
import type { AuthResult, AuthVerifier, AuthVerifierFactory, Identity } from "../types.js";
import { extractToken, invalidTokenResult, remoteJwks } from "./token.js";

const TYPE = "supabase";

const optionsSchema = z
  .strictObject({
    type: z.literal(TYPE).optional(),
    name: z.string().optional(),
    /** Supabase project URL, e.g. "https://abcdefgh.supabase.co". */
    url: z.url().optional(),
    /** Legacy shared JWT secret (HS256). */
    jwtSecret: z.string().min(1).optional(),
    /** Explicit JWKS endpoint; defaults to `<url>/auth/v1/.well-known/jwks.json`. */
    jwksUrl: z.url().optional(),
    /** Expected issuer; defaults to `<url>/auth/v1` when `url` is set. */
    issuer: z.string().min(1).optional(),
    /** Expected audience; defaults to "authenticated". */
    audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    /** Header carrying the access token as `Bearer <token>`. */
    header: z.string().min(1).default("authorization"),
    clockToleranceSeconds: z.number().int().nonnegative().default(60),
  })
  .superRefine((options, issues) => {
    if (options.jwtSecret !== undefined && options.jwksUrl !== undefined) {
      issues.addIssue({
        code: "custom",
        message: "provide either `jwtSecret` (HS256) or `jwksUrl` (asymmetric keys), not both",
      });
    }
    if (
      options.jwtSecret === undefined &&
      options.jwksUrl === undefined &&
      options.url === undefined
    ) {
      issues.addIssue({
        code: "custom",
        message: "provide `jwtSecret`, `jwksUrl`, or `url` (to derive the JWKS endpoint)",
      });
    }
  });

/**
 * Verifies Supabase Auth access tokens, either with the project's legacy
 * shared JWT secret (HS256) or against the project's JWKS for asymmetric
 * signing keys. `sub` becomes `identity.userId`; Supabase claims such as
 * `role` and `app_metadata` are exposed via `identity.claims`.
 */
export const supabaseVerifierFactory: AuthVerifierFactory = {
  type: TYPE,
  create(options: Record<string, unknown>, runtime: RuntimeContext): AuthVerifier {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ConfigError(
        `invalid "${TYPE}" verifier options:\n${z.prettifyError(parsed.error)}`,
      );
    }
    const opts = parsed.data;
    const baseUrl = opts.url?.replace(/\/+$/, "");
    const verifyOptions = {
      issuer: opts.issuer ?? (baseUrl === undefined ? undefined : `${baseUrl}/auth/v1`),
      audience: opts.audience ?? "authenticated",
      clockTolerance: opts.clockToleranceSeconds,
    };

    let verifyToken: (token: string, currentDate: Date) => Promise<JWTVerifyResult<JWTPayload>>;
    if (opts.jwtSecret !== undefined) {
      const key = new TextEncoder().encode(opts.jwtSecret);
      verifyToken = (token, currentDate) =>
        jwtVerify(token, key, { ...verifyOptions, algorithms: ["HS256"], currentDate });
    } else {
      const jwksUrl = opts.jwksUrl ?? `${baseUrl}/auth/v1/.well-known/jwks.json`;
      const jwks = remoteJwks(jwksUrl, runtime);
      verifyToken = (token, currentDate) =>
        jwtVerify(token, jwks, { ...verifyOptions, currentDate });
    }

    return {
      type: TYPE,
      name: opts.name ?? TYPE,
      async verify(request, ctx): Promise<AuthResult | null> {
        const token = extractToken(request, opts.header, "bearer");
        if (token === null) return null;
        try {
          const { payload } = await verifyToken(token, new Date(ctx.now()));
          const identity: Identity = { provider: TYPE, claims: payload };
          if (typeof payload.sub === "string" && payload.sub !== "") {
            identity.userId = payload.sub;
          }
          return { ok: true, identity };
        } catch (error) {
          return invalidTokenResult(error);
        }
      },
    };
  },
};
