import { jwtVerify } from "jose";
import { z } from "zod";
import { ConfigError } from "../../errors.js";
import type { RuntimeContext } from "../../types.js";
import type { AuthResult, AuthVerifier, AuthVerifierFactory } from "../types.js";
import { extractToken, invalidTokenResult, remoteJwks } from "./token.js";

const TYPE = "firebase-auth";

/** Google-hosted JWKS for the key pair that signs Firebase Auth ID tokens. */
const FIREBASE_AUTH_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const optionsSchema = z.strictObject({
  type: z.literal(TYPE).optional(),
  name: z.string().optional(),
  /** Firebase project id, e.g. "my-app-12345". */
  projectId: z.string().min(1),
  /** Header carrying the ID token as `Bearer <token>`. */
  header: z.string().min(1).default("authorization"),
  clockToleranceSeconds: z.number().int().nonnegative().default(60),
});

/**
 * Verifies Firebase Authentication ID tokens (RS256) against Google's
 * secure-token JWKS. The Firebase uid (`sub`) becomes `identity.userId`.
 */
export const firebaseAuthVerifierFactory: AuthVerifierFactory = {
  type: TYPE,
  create(options: Record<string, unknown>, runtime: RuntimeContext): AuthVerifier {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ConfigError(
        `invalid "${TYPE}" verifier options:\n${z.prettifyError(parsed.error)}`,
      );
    }
    const opts = parsed.data;
    const jwks = remoteJwks(FIREBASE_AUTH_JWKS_URL, runtime);

    return {
      type: TYPE,
      name: opts.name ?? TYPE,
      async verify(request, ctx): Promise<AuthResult | null> {
        const token = extractToken(request, opts.header, "bearer");
        if (token === null) return null;
        try {
          const { payload } = await jwtVerify(token, jwks, {
            algorithms: ["RS256"],
            issuer: `https://securetoken.google.com/${opts.projectId}`,
            audience: opts.projectId,
            clockTolerance: opts.clockToleranceSeconds,
            currentDate: new Date(ctx.now()),
          });
          if (typeof payload.sub !== "string" || payload.sub === "") {
            return { ok: false, reason: "token has no subject (uid)" };
          }
          return {
            ok: true,
            identity: { provider: TYPE, userId: payload.sub, claims: payload },
          };
        } catch (error) {
          return invalidTokenResult(error);
        }
      },
    };
  },
};
