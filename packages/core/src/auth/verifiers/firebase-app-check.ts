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
    .regex(/^\d+$/, "projectNumber must be the numeric Firebase project number")
    .optional(),
  /** Optional allowlist of Firebase app ids (the token `sub`). */
  appIds: z.array(z.string().min(1)).min(1).optional(),
  /** Header carrying the raw App Check token (no scheme). */
  header: z.string().min(1).default("x-firebase-appcheck"),
  /** Consume limited-use tokens through Firebase to prevent replay. */
  consume: z.boolean().default(false),
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
    if (opts.consume && runtime.consumeFirebaseAppCheckToken === undefined) {
      throw new ConfigError(
        `invalid "${TYPE}" verifier options: consume requires a Firebase App Check token ` +
          "consumer from the hosting runtime; use @omni-model/node on Cloud Run/GCE or disable consume",
      );
    }
    const projectNumber = opts.projectNumber ?? runtime.env.OMNI_GCP_PROJECT_NUMBER;
    if (projectNumber === undefined || !/^\d+$/.test(projectNumber)) {
      throw new ConfigError(
        `invalid "${TYPE}" verifier options: provide a numeric projectNumber, or run ` +
          "@omni-model/node on GCP so it can read OMNI_GCP_PROJECT_NUMBER from metadata",
      );
    }
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
            issuer: `https://firebaseappcheck.googleapis.com/${projectNumber}`,
            // App Check `aud` is an array; jose accepts when it contains this value.
            audience: `projects/${projectNumber}`,
            clockTolerance: opts.clockToleranceSeconds,
            currentDate: new Date(ctx.now()),
          });
          if (typeof payload.sub !== "string" || payload.sub === "") {
            return { ok: false, reason: "token has no subject (app id)" };
          }
          if (opts.appIds !== undefined && !opts.appIds.includes(payload.sub)) {
            return { ok: false, reason: `app "${payload.sub}" is not in the allowed app list` };
          }
          if (opts.consume) {
            const consumption = await runtime.consumeFirebaseAppCheckToken?.(token);
            // The consumer is checked at construction; this guard preserves the
            // fail-closed contract if an embedder mutates its runtime afterward.
            if (consumption === undefined) {
              throw new Error("Firebase App Check token consumer is unavailable");
            }
            if (consumption.alreadyConsumed) {
              return { ok: false, reason: "App Check token has already been used" };
            }
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
