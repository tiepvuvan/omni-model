import type { CryptoKey as JoseCryptoKey, JWTPayload, JWTVerifyResult } from "jose";
import { importSPKI, jwtVerify } from "jose";
import { z } from "zod";
import { ConfigError } from "../../errors.js";
import type { RuntimeContext } from "../../types.js";
import type { AuthResult, AuthVerifier, AuthVerifierFactory, Identity } from "../types.js";
import { extractToken, invalidTokenResult, remoteJwks } from "./token.js";

const TYPE = "jwt";

const optionsSchema = z
  .strictObject({
    type: z.literal(TYPE).optional(),
    name: z.string().optional(),
    /** Header carrying the token. */
    header: z.string().min(1).default("authorization"),
    /** "bearer" strips a `Bearer ` prefix; "none" uses the raw header value. */
    scheme: z.enum(["bearer", "none"]).default("bearer"),
    /** Remote JWKS endpoint for asymmetric keys. */
    jwksUrl: z.url().optional(),
    /** Shared secret for HS* algorithms. */
    secret: z.string().min(1).optional(),
    /** SPKI PEM public key; requires exactly one entry in `algorithms`. */
    publicKey: z
      .string()
      .regex(/-----BEGIN PUBLIC KEY-----/, "publicKey must be an SPKI PEM block")
      .optional(),
    /** Allowed JWS algorithms, e.g. ["RS256"]. */
    algorithms: z.array(z.string().min(1)).min(1).optional(),
    issuer: z.string().min(1).optional(),
    audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    /** Claim mapped to `identity.userId`. */
    userIdClaim: z.string().min(1).default("sub"),
    /** Claim mapped to `identity.deviceId`, if any. */
    deviceIdClaim: z.string().min(1).optional(),
    clockToleranceSeconds: z.number().int().nonnegative().default(60),
  })
  .superRefine((options, issues) => {
    const sources = [options.jwksUrl, options.secret, options.publicKey].filter(
      (source) => source !== undefined,
    );
    if (sources.length !== 1) {
      issues.addIssue({
        code: "custom",
        message: "provide exactly one of `jwksUrl`, `secret` or `publicKey`",
      });
    }
    if (options.publicKey !== undefined && options.algorithms?.length !== 1) {
      issues.addIssue({
        code: "custom",
        message: "`publicKey` requires `algorithms` with exactly one entry (e.g. [RS256])",
      });
    }
  });

/**
 * Verifies arbitrary JWTs from any issuer against a JWKS endpoint, a shared
 * secret (HS*) or a pinned SPKI public key. Claims are exposed to CEL rules
 * as `user.claims`.
 */
export const jwtVerifierFactory: AuthVerifierFactory = {
  type: TYPE,
  create(options: Record<string, unknown>, runtime: RuntimeContext): AuthVerifier {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ConfigError(
        `invalid "${TYPE}" verifier options:\n${z.prettifyError(parsed.error)}`,
      );
    }
    const opts = parsed.data;
    const verifyOptions = {
      algorithms: opts.algorithms,
      issuer: opts.issuer,
      audience: opts.audience,
      clockTolerance: opts.clockToleranceSeconds,
    };

    let verifyToken: (token: string, currentDate: Date) => Promise<JWTVerifyResult<JWTPayload>>;
    if (opts.jwksUrl !== undefined) {
      const jwks = remoteJwks(opts.jwksUrl, runtime);
      verifyToken = (token, currentDate) =>
        jwtVerify(token, jwks, { ...verifyOptions, currentDate });
    } else if (opts.secret !== undefined) {
      const key = new TextEncoder().encode(opts.secret);
      verifyToken = (token, currentDate) =>
        jwtVerify(token, key, { ...verifyOptions, currentDate });
    } else if (opts.publicKey !== undefined) {
      const publicKey = opts.publicKey;
      const alg = opts.algorithms?.[0];
      if (alg === undefined) throw new ConfigError("`publicKey` requires `algorithms`");
      // importSPKI is async, so import lazily and reuse across requests.
      let keyPromise: Promise<JoseCryptoKey> | undefined;
      verifyToken = async (token, currentDate) => {
        keyPromise ??= importSPKI(publicKey, alg);
        return jwtVerify(token, await keyPromise, { ...verifyOptions, currentDate });
      };
    } else {
      throw new ConfigError("provide exactly one of `jwksUrl`, `secret` or `publicKey`");
    }

    return {
      type: TYPE,
      name: opts.name ?? TYPE,
      async verify(request, ctx): Promise<AuthResult | null> {
        const token = extractToken(request, opts.header, opts.scheme);
        if (token === null) return null;
        try {
          const { payload } = await verifyToken(token, new Date(ctx.now()));
          const claims: Record<string, unknown> = payload;
          const identity: Identity = { provider: TYPE, claims };
          const userId = claims[opts.userIdClaim];
          if (userId !== undefined && userId !== null) identity.userId = String(userId);
          if (opts.deviceIdClaim !== undefined) {
            const deviceId = claims[opts.deviceIdClaim];
            if (deviceId !== undefined && deviceId !== null) identity.deviceId = String(deviceId);
          }
          return { ok: true, identity };
        } catch (error) {
          return invalidTokenResult(error);
        }
      },
    };
  },
};
