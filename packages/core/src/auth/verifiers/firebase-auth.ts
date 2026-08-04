import { jwtVerify } from "jose";
import { z } from "zod";
import { ConfigError } from "../../errors.js";
import type { RuntimeContext } from "../../types.js";
import { testJwks } from "../configuration-test.js";
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
  /** Optional Firebase Web API key, used to confirm that `projectId` matches. */
  apiKey: z.string().min(1).optional(),
  /** Header carrying the ID token. Authorization is reserved for publishable keys. */
  header: z.string().min(1).default("x-firebase-id-token"),
  /** "bearer" strips a `Bearer ` prefix; "none" uses the raw header value. */
  scheme: z.enum(["bearer", "none"]).default("none"),
  clockToleranceSeconds: z.number().int().nonnegative().default(60),
});

/**
 * Verifies Firebase Authentication ID tokens (RS256) against Google's
 * secure-token JWKS. The Firebase uid (`sub`) becomes `identity.userId`.
 */
export const firebaseAuthVerifierFactory: AuthVerifierFactory = {
  type: TYPE,
  layer: "user",
  optionsSchema: optionsSchema,
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
      async testConfiguration(ctx) {
        if (opts.apiKey === undefined) {
          const keys = await testJwks(FIREBASE_AUTH_JWKS_URL, ctx, "Firebase Authentication");
          if (keys.ok === false) return keys;
          return {
            ok: null,
            reason:
              "Firebase signing keys are reachable. Add the Firebase Web API key to verify that " +
              "the project ID belongs to this app.",
          };
        }

        let response: Response;
        try {
          response = await ctx.fetch(
            `https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(
              opts.apiKey,
            )}`,
            { headers: { accept: "application/json" } },
          );
        } catch {
          return { ok: false, message: "Firebase Authentication could not be reached." };
        }
        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            message: `Firebase rejected the Web API key (HTTP ${response.status}).`,
          };
        }
        const body: unknown = await response.json().catch(() => null);
        const projectId =
          typeof body === "object" && body !== null && "projectId" in body
            ? (body as { projectId?: unknown }).projectId
            : undefined;
        if (projectId !== opts.projectId) {
          return {
            ok: false,
            message: "The Firebase Web API key belongs to a different project ID.",
          };
        }
        return { ok: true, message: `Firebase project “${opts.projectId}” was verified.` };
      },
      async verify(request, ctx): Promise<AuthResult | null> {
        const token = extractToken(request, opts.header, opts.scheme);
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
