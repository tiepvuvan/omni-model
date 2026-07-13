import { jwtVerify } from "jose";
import { z } from "zod";
import { ConfigError } from "../../errors.js";
import type { RuntimeContext } from "../../types.js";
import type { AuthResult, AuthVerifier, AuthVerifierFactory } from "../types.js";
import { extractToken, invalidTokenResult, remoteJwks } from "./token.js";

const TYPE = "firebase-app-check";

const APP_CHECK_JWKS_URL = "https://firebaseappcheck.googleapis.com/v1/jwks";

const optionsSchema = z.strictObject({
  type: z.literal(TYPE).optional(),
  name: z.string().optional(),
  /** Numeric Firebase project number (not the project id). */
  projectNumber: z
    .string()
    .regex(/^\d+$/, "projectNumber must be the numeric Firebase project number"),
  /** Optional allowlist of Firebase app ids (the token `sub`). */
  appIds: z.array(z.string().min(1)).min(1).optional(),
  /** Header carrying the raw App Check token (no scheme). */
  header: z.string().min(1).default("x-firebase-appcheck"),
  clockToleranceSeconds: z.number().int().nonnegative().default(60),
});

/**
 * Verifies Firebase App Check tokens, attesting that requests come from an
 * authentic app instance. The Firebase app id (`sub`) becomes
 * `identity.deviceId`; App Check tokens carry no user, so `userId` is unset.
 */
export const firebaseAppCheckVerifierFactory: AuthVerifierFactory = {
  type: TYPE,
  create(options: Record<string, unknown>, runtime: RuntimeContext): AuthVerifier {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ConfigError(
        `invalid "${TYPE}" verifier options:\n${z.prettifyError(parsed.error)}`,
      );
    }
    const opts = parsed.data;
    const jwks = remoteJwks(APP_CHECK_JWKS_URL, runtime);

    return {
      type: TYPE,
      name: opts.name ?? TYPE,
      async verify(request, ctx): Promise<AuthResult | null> {
        const token = extractToken(request, opts.header, "none");
        if (token === null) return null;
        try {
          const { payload } = await jwtVerify(token, jwks, {
            algorithms: ["RS256"],
            typ: "JWT",
            issuer: `https://firebaseappcheck.googleapis.com/${opts.projectNumber}`,
            // App Check `aud` is an array; jose accepts when it contains this value.
            audience: `projects/${opts.projectNumber}`,
            clockTolerance: opts.clockToleranceSeconds,
            currentDate: new Date(ctx.now()),
          });
          if (typeof payload.sub !== "string" || payload.sub === "") {
            return { ok: false, reason: "token has no subject (app id)" };
          }
          if (opts.appIds !== undefined && !opts.appIds.includes(payload.sub)) {
            return { ok: false, reason: `app "${payload.sub}" is not in the allowed app list` };
          }
          return {
            ok: true,
            identity: { provider: TYPE, deviceId: payload.sub, claims: payload },
          };
        } catch (error) {
          return invalidTokenResult(error);
        }
      },
    };
  },
};
