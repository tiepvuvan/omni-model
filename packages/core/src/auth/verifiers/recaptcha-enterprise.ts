import { z } from "zod";
import { ConfigError } from "../../errors.js";
import type { RuntimeContext } from "../../types.js";
import { validateGoogleServiceAccountKey } from "../google.js";
import type { AuthResult, AuthVerifier, AuthVerifierFactory } from "../types.js";

const TYPE = "recaptcha-enterprise";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const optionsSchema = z.strictObject({
  type: z.literal(TYPE).optional(),
  name: z.string().optional(),
  /** Google Cloud project that owns the reCAPTCHA key. */
  projectId: z.string().min(1),
  /** reCAPTCHA Enterprise site/app key used by the client. */
  siteKey: z.string().min(1),
  /** Server API key; omit to use Google OAuth through ADC/WIF. */
  apiKey: z.string().min(1).optional(),
  /** Optional service-account JSON instead of ADC/WIF. */
  serviceAccountKey: z.string().min(1).optional(),
  /** Client action that must be bound into the assessed token. */
  expectedAction: z.string().min(1),
  /** Lowest risk-analysis score accepted by this verifier. */
  minScore: z.number().min(0).max(1),
  /** Header carrying a fresh reCAPTCHA Enterprise token. */
  header: z.string().min(1).default("x-recaptcha-token"),
  /** Optional allowlists for the origin reported by the token. */
  hostnames: z.array(z.string().min(1)).min(1).optional(),
  androidPackageNames: z.array(z.string().min(1)).min(1).optional(),
  iosBundleIds: z.array(z.string().min(1)).min(1).optional(),
});

interface Assessment {
  valid: boolean;
  invalidReason?: string;
  createTime?: string;
  action?: string;
  hostname?: string;
  androidPackageName?: string;
  iosBundleId?: string;
  score?: number;
  reasons: string[];
  challenge?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAssessment(value: unknown): Assessment | null {
  if (!isRecord(value) || !isRecord(value.tokenProperties)) return null;
  const token = value.tokenProperties;
  if (typeof token.valid !== "boolean") return null;
  const risk = isRecord(value.riskAnalysis) ? value.riskAnalysis : {};
  return {
    valid: token.valid,
    ...(typeof token.invalidReason === "string" ? { invalidReason: token.invalidReason } : {}),
    ...(typeof token.createTime === "string" ? { createTime: token.createTime } : {}),
    ...(typeof token.action === "string" ? { action: token.action } : {}),
    ...(typeof token.hostname === "string" ? { hostname: token.hostname } : {}),
    ...(typeof token.androidPackageName === "string"
      ? { androidPackageName: token.androidPackageName }
      : {}),
    ...(typeof token.iosBundleId === "string" ? { iosBundleId: token.iosBundleId } : {}),
    ...(typeof risk.score === "number" && Number.isFinite(risk.score) ? { score: risk.score } : {}),
    reasons: Array.isArray(risk.reasons)
      ? risk.reasons.filter((entry): entry is string => typeof entry === "string")
      : [],
    ...(typeof risk.challenge === "string" ? { challenge: risk.challenge } : {}),
  };
}

function originAllowed(
  assessment: Assessment,
  options: {
    hostnames?: string[];
    androidPackageNames?: string[];
    iosBundleIds?: string[];
  },
): boolean {
  const constrained =
    options.hostnames !== undefined ||
    options.androidPackageNames !== undefined ||
    options.iosBundleIds !== undefined;
  if (!constrained) return true;
  return (
    (assessment.hostname !== undefined &&
      options.hostnames?.includes(assessment.hostname) === true) ||
    (assessment.androidPackageName !== undefined &&
      options.androidPackageNames?.includes(assessment.androidPackageName) === true) ||
    (assessment.iosBundleId !== undefined &&
      options.iosBundleIds?.includes(assessment.iosBundleId) === true)
  );
}

function unavailable(): AuthResult {
  return { ok: false, status: 503, reason: "reCAPTCHA Enterprise verification unavailable" };
}

/**
 * Creates a backend-only reCAPTCHA Enterprise assessment and enforces token
 * validity, action binding, score, and optional web/mobile origin allowlists.
 */
export const recaptchaEnterpriseVerifierFactory: AuthVerifierFactory = {
  type: TYPE,
  layer: "app",
  optionsSchema,
  create(options: Record<string, unknown>, runtime: RuntimeContext): AuthVerifier {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ConfigError(
        `invalid "${TYPE}" verifier options:\n${z.prettifyError(parsed.error)}`,
      );
    }
    const opts = parsed.data;
    if (opts.apiKey !== undefined && opts.serviceAccountKey !== undefined) {
      throw new ConfigError(
        `invalid "${TYPE}" verifier options: apiKey and serviceAccountKey are mutually exclusive`,
      );
    }
    const serviceAccountKey = validateGoogleServiceAccountKey(TYPE, opts.serviceAccountKey);
    if (opts.apiKey === undefined && runtime.getGoogleAccessToken === undefined) {
      throw new ConfigError(
        `invalid "${TYPE}" verifier options: OAuth verification requires the hosting runtime ` +
          "to provide Google credentials; configure apiKey or use @omni-model/node",
      );
    }
    const endpoint =
      `https://recaptchaenterprise.googleapis.com/v1/projects/` +
      `${encodeURIComponent(opts.projectId)}/assessments`;

    return {
      type: TYPE,
      name: opts.name ?? TYPE,
      async testConfiguration(ctx) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (opts.apiKey !== undefined) {
          headers["x-goog-api-key"] = opts.apiKey;
        } else {
          try {
            const accessToken = await runtime.getGoogleAccessToken?.({
              scopes: [CLOUD_PLATFORM_SCOPE],
              ...(serviceAccountKey === undefined ? {} : { serviceAccountKey }),
            });
            if (accessToken === undefined) {
              return { ok: false, message: "Google OAuth credentials are unavailable." };
            }
            headers.authorization = `Bearer ${accessToken}`;
          } catch {
            return { ok: false, message: "Google OAuth rejected the reCAPTCHA credentials." };
          }
        }

        let response: Response;
        try {
          response = await ctx.fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({
              event: {
                token: "omni-model-configuration-test",
                siteKey: opts.siteKey,
                expectedAction: opts.expectedAction,
              },
            }),
          });
        } catch {
          return { ok: false, message: "reCAPTCHA Enterprise could not be reached." };
        }
        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            message: `Google rejected the reCAPTCHA configuration (HTTP ${response.status}).`,
          };
        }
        if (parseAssessment(await response.json().catch(() => null)) === null) {
          return { ok: false, message: "reCAPTCHA Enterprise returned an invalid assessment." };
        }
        return {
          ok: true,
          message:
            "Google accepted the reCAPTCHA project, site key, and server credential; the " +
            "synthetic token was rejected.",
        };
      },
      async verify(request, ctx): Promise<AuthResult | null> {
        const token = request.headers.get(opts.header);
        if (token === null || token === "") return null;

        const headers: Record<string, string> = { "content-type": "application/json" };
        if (opts.apiKey !== undefined) {
          headers["x-goog-api-key"] = opts.apiKey;
        } else {
          try {
            const accessToken = await runtime.getGoogleAccessToken?.({
              scopes: [CLOUD_PLATFORM_SCOPE],
              ...(serviceAccountKey === undefined ? {} : { serviceAccountKey }),
            });
            if (accessToken === undefined) return unavailable();
            headers.authorization = `Bearer ${accessToken}`;
          } catch {
            return unavailable();
          }
        }

        let response: Response;
        try {
          response = await ctx.fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({
              event: {
                token,
                siteKey: opts.siteKey,
                expectedAction: opts.expectedAction,
                ...(request.headers.get("user-agent") === null
                  ? {}
                  : { userAgent: request.headers.get("user-agent") }),
                ...(ctx.clientIp === undefined || ctx.clientIp === null
                  ? {}
                  : { userIpAddress: ctx.clientIp }),
              },
            }),
          });
        } catch {
          return unavailable();
        }
        if (!response.ok) return unavailable();
        const assessment = parseAssessment(await response.json().catch(() => null));
        if (assessment === null) return unavailable();
        if (!assessment.valid) {
          return { ok: false, reason: "reCAPTCHA Enterprise token was rejected" };
        }
        if (assessment.action !== opts.expectedAction) {
          return { ok: false, reason: "reCAPTCHA Enterprise action does not match" };
        }
        if (assessment.score === undefined) return unavailable();
        if (assessment.score < opts.minScore) {
          return { ok: false, reason: "reCAPTCHA Enterprise score is too low" };
        }
        if (!originAllowed(assessment, opts)) {
          return { ok: false, reason: "reCAPTCHA Enterprise origin is not allowed" };
        }

        return {
          ok: true,
          identity: {
            provider: TYPE,
            claims: {
              score: assessment.score,
              reasons: assessment.reasons,
              action: assessment.action,
              ...(assessment.createTime === undefined ? {} : { createTime: assessment.createTime }),
              ...(assessment.hostname === undefined ? {} : { hostname: assessment.hostname }),
              ...(assessment.androidPackageName === undefined
                ? {}
                : { androidPackageName: assessment.androidPackageName }),
              ...(assessment.iosBundleId === undefined
                ? {}
                : { iosBundleId: assessment.iosBundleId }),
              ...(assessment.challenge === undefined ? {} : { challenge: assessment.challenge }),
            },
          },
        };
      },
    };
  },
};
