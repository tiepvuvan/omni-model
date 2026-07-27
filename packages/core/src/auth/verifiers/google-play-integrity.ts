import { z } from "zod";
import { ConfigError } from "../../errors.js";
import type { RuntimeContext } from "../../types.js";
import { parseDuration } from "../../util/duration.js";
import { validateGoogleServiceAccountKey } from "../google.js";
import type { AuthResult, AuthVerifier, AuthVerifierFactory } from "../types.js";

const TYPE = "google-play-integrity";
const PLAY_INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity";
const DEFAULT_MAX_BODY_BYTES = 128 * 1024;

const deviceVerdictSchema = z.enum([
  "MEETS_BASIC_INTEGRITY",
  "MEETS_DEVICE_INTEGRITY",
  "MEETS_STRONG_INTEGRITY",
  "MEETS_VIRTUAL_INTEGRITY",
]);

const optionsSchema = z.strictObject({
  type: z.literal(TYPE).optional(),
  name: z.string().optional(),
  /** Android application id whose Standard API tokens are accepted. */
  packageName: z.string().min(1),
  /** Optional service-account JSON instead of ADC/WIF. */
  serviceAccountKey: z.string().min(1).optional(),
  /** Header carrying a fresh encrypted Standard Integrity token. */
  header: z.string().min(1).default("x-google-play-integrity"),
  /** Maximum accepted age of the integrity request timestamp. */
  maxAge: z.string().default("2m"),
  /** Future-clock skew tolerated on the integrity request timestamp. */
  clockToleranceSeconds: z.number().int().nonnegative().default(30),
  /** Any one of these device labels is sufficient. */
  deviceRecognitionVerdicts: z
    .array(deviceVerdictSchema)
    .min(1)
    .default(["MEETS_DEVICE_INTEGRITY"]),
  /** Require the signed-in Play account to hold an app license. */
  requireLicensed: z.boolean().default(false),
  /** Optional allowlist of base64url SHA-256 app-signing certificate digests. */
  certificateSha256Digests: z.array(z.string().min(1)).min(1).optional(),
});

interface PlayPayload {
  requestPackageName?: string;
  requestHash?: string;
  timestampMillis?: number;
  appRecognitionVerdict?: string;
  appPackageName?: string;
  certificateSha256Digests: string[];
  versionCode?: string;
  deviceRecognitionVerdicts: string[];
  appLicensingVerdict?: string;
  appIntegrity: Record<string, unknown>;
  deviceIntegrity: Record<string, unknown>;
  accountDetails: Record<string, unknown>;
  environmentDetails?: Record<string, unknown>;
  testingDetails?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePayload(value: unknown): PlayPayload | null {
  if (!isRecord(value) || !isRecord(value.tokenPayloadExternal)) return null;
  const payload = value.tokenPayloadExternal;
  if (
    !isRecord(payload.requestDetails) ||
    !isRecord(payload.appIntegrity) ||
    !isRecord(payload.deviceIntegrity) ||
    !isRecord(payload.accountDetails)
  ) {
    return null;
  }
  const request = payload.requestDetails;
  const app = payload.appIntegrity;
  const device = payload.deviceIntegrity;
  const account = payload.accountDetails;
  return {
    ...(typeof request.requestPackageName === "string"
      ? { requestPackageName: request.requestPackageName }
      : {}),
    ...(typeof request.requestHash === "string" ? { requestHash: request.requestHash } : {}),
    ...(parseTimestamp(request.timestampMillis) === undefined
      ? {}
      : { timestampMillis: parseTimestamp(request.timestampMillis) }),
    ...(typeof app.appRecognitionVerdict === "string"
      ? { appRecognitionVerdict: app.appRecognitionVerdict }
      : {}),
    ...(typeof app.packageName === "string" ? { appPackageName: app.packageName } : {}),
    certificateSha256Digests: strings(app.certificateSha256Digest),
    ...(typeof app.versionCode === "string" ? { versionCode: app.versionCode } : {}),
    deviceRecognitionVerdicts: strings(device.deviceRecognitionVerdict),
    ...(typeof account.appLicensingVerdict === "string"
      ? { appLicensingVerdict: account.appLicensingVerdict }
      : {}),
    appIntegrity: app,
    deviceIntegrity: device,
    accountDetails: account,
    ...(isRecord(payload.environmentDetails)
      ? { environmentDetails: payload.environmentDetails }
      : {}),
    ...(isRecord(payload.testingDetails) ? { testingDetails: payload.testingDetails } : {}),
  };
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Compute omni-model's Play Integrity request binding:
 * SHA-256 over `METHOD + "\n" + path-and-query + "\n" + exact body bytes`,
 * encoded as unpadded base64url.
 */
export async function googlePlayIntegrityRequestHash(
  method: string,
  pathAndQuery: string,
  body: Uint8Array,
): Promise<string> {
  const prefix = new TextEncoder().encode(`${method.toUpperCase()}\n${pathAndQuery}\n`);
  const digest = await crypto.subtle.digest("SHA-256", concatBytes(prefix, body));
  return base64Url(new Uint8Array(digest));
}

async function boundedBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.clone().body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatBytes(...chunks);
}

function unavailable(): AuthResult {
  return { ok: false, status: 503, reason: "Google Play Integrity verification unavailable" };
}

/**
 * Verifies Google Play Integrity Standard API tokens. The token is decoded by
 * Google, then bound to the exact HTTP request and checked for freshness, app
 * recognition, device integrity, licensing, and optional certificate pins.
 */
export const googlePlayIntegrityVerifierFactory: AuthVerifierFactory = {
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
    const serviceAccountKey = validateGoogleServiceAccountKey(TYPE, opts.serviceAccountKey);
    const getGoogleAccessToken = runtime.getGoogleAccessToken;
    if (getGoogleAccessToken === undefined) {
      throw new ConfigError(
        `invalid "${TYPE}" verifier options: the hosting runtime must provide Google OAuth; ` +
          "use @omni-model/node with ADC/WIF or serviceAccountKey",
      );
    }
    let maxAgeMs: number;
    try {
      maxAgeMs = parseDuration(opts.maxAge);
    } catch {
      throw new ConfigError(`invalid "${TYPE}" verifier options: maxAge is not a valid duration`);
    }
    if (maxAgeMs <= 0) {
      throw new ConfigError(`invalid "${TYPE}" verifier options: maxAge must be positive`);
    }
    const endpoint =
      `https://playintegrity.googleapis.com/v1/` +
      `${encodeURIComponent(opts.packageName)}:decodeIntegrityToken`;

    return {
      type: TYPE,
      name: opts.name ?? TYPE,
      async verify(request, ctx): Promise<AuthResult | null> {
        const token = request.headers.get(opts.header);
        if (token === null || token === "") return null;

        const body = await boundedBody(request, ctx.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
        if (body === null) {
          return {
            ok: false,
            status: 413,
            reason: `request body exceeds the configured byte limit`,
          };
        }
        const url = new URL(request.url);
        const expectedHash = await googlePlayIntegrityRequestHash(
          request.method,
          `${url.pathname}${url.search}`,
          body,
        );

        let accessToken: string;
        try {
          accessToken = await getGoogleAccessToken({
            scopes: [PLAY_INTEGRITY_SCOPE],
            ...(serviceAccountKey === undefined ? {} : { serviceAccountKey }),
          });
        } catch {
          return unavailable();
        }

        let response: Response;
        try {
          response = await ctx.fetch(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ integrityToken: token }),
          });
        } catch {
          return unavailable();
        }
        if (!response.ok) {
          return response.status === 400
            ? { ok: false, reason: "Google Play Integrity token was rejected" }
            : unavailable();
        }
        const payload = parsePayload(await response.json().catch(() => null));
        if (payload === null) return unavailable();

        const toleranceMs = opts.clockToleranceSeconds * 1000;
        const timestamp = payload.timestampMillis;
        if (
          payload.requestPackageName !== opts.packageName ||
          payload.requestHash !== expectedHash ||
          timestamp === undefined ||
          timestamp > ctx.now() + toleranceMs ||
          ctx.now() - timestamp > maxAgeMs
        ) {
          return { ok: false, reason: "Google Play Integrity request binding is invalid" };
        }
        if (
          payload.appRecognitionVerdict !== "PLAY_RECOGNIZED" ||
          payload.appPackageName !== opts.packageName
        ) {
          return { ok: false, reason: "Google Play did not recognize this app version" };
        }
        if (
          !opts.deviceRecognitionVerdicts.some((verdict) =>
            payload.deviceRecognitionVerdicts.includes(verdict),
          )
        ) {
          return { ok: false, reason: "Google Play device integrity requirement was not met" };
        }
        if (opts.requireLicensed && payload.appLicensingVerdict !== "LICENSED") {
          return { ok: false, reason: "Google Play app license is required" };
        }
        if (
          opts.certificateSha256Digests !== undefined &&
          !opts.certificateSha256Digests.some((digest) =>
            payload.certificateSha256Digests.includes(digest),
          )
        ) {
          return { ok: false, reason: "Google Play app certificate is not allowed" };
        }

        return {
          ok: true,
          identity: {
            provider: TYPE,
            claims: {
              appIntegrity: payload.appIntegrity,
              deviceIntegrity: payload.deviceIntegrity,
              accountDetails: payload.accountDetails,
              ...(payload.environmentDetails === undefined
                ? {}
                : { environmentDetails: payload.environmentDetails }),
              ...(payload.testingDetails === undefined
                ? {}
                : { testingDetails: payload.testingDetails }),
            },
          },
        };
      },
    };
  },
};
