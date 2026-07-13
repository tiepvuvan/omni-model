import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import { ConfigError } from "../../errors.js";
import type { RuntimeContext } from "../../types.js";
import { parseDuration } from "../../util/duration.js";
import type { AuthVerifier, AuthVerifierFactory, VerifyContext } from "../types.js";
import { hex, sha256, utf8 } from "./bytes.js";

const PRODUCTION_URL = "https://api.devicecheck.apple.com/v1/validate_device_token";
const DEVELOPMENT_URL = "https://api.development.devicecheck.apple.com/v1/validate_device_token";

/**
 * Apple allows DeviceCheck API JWTs to be up to one hour old; re-sign a
 * little before that so a token is never rejected mid-flight.
 */
const JWT_REUSE_MS = 50 * 60_000;

const optionsSchema = z.strictObject({
  type: z.literal("apple-device-check").optional(),
  name: z.string().min(1).optional(),
  /** Apple Developer team identifier (JWT `iss`). */
  teamId: z.string().min(1),
  /** Key identifier of the DeviceCheck .p8 key (JWT header `kid`). */
  keyId: z.string().min(1),
  /** PKCS8 PEM contents of the .p8 key, typically `${APPLE_DEVICECHECK_KEY}`. */
  privateKey: z.string().min(1),
  /** Use Apple's development DeviceCheck endpoint. */
  development: z.boolean().default(false),
  /** Request header carrying the device token. */
  header: z.string().min(1).default("x-apple-device-token"),
  /** How long a successfully validated token is cached ("5m", "1h", ...). */
  cacheTtl: z.string().default("5m"),
});

/**
 * Verifies Apple DeviceCheck device tokens by calling Apple's
 * `validate_device_token` endpoint, authenticated with an ES256 JWT signed by
 * the configured .p8 key. Successful validations are cached in shared storage
 * (key `dc:<sha256(token)>`) for `cacheTtl` so hot devices don't hit Apple on
 * every request. Apple 4xx responses reject the request with Apple's error
 * text; network failures and Apple 5xx map to a generic "unavailable"
 * rejection so the raw token never leaks into logs or error bodies.
 */
export const appleDeviceCheckVerifierFactory: AuthVerifierFactory = {
  type: "apple-device-check",
  create(options: Record<string, unknown>, _runtime: RuntimeContext): AuthVerifier {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ConfigError(`apple-device-check: ${z.prettifyError(parsed.error)}`);
    }
    const opts = parsed.data;
    if (!opts.privateKey.includes("-----BEGIN PRIVATE KEY-----")) {
      throw new ConfigError(
        "apple-device-check: privateKey must be the PKCS8 PEM contents of the .p8 key " +
          '(starting with "-----BEGIN PRIVATE KEY-----"); did the env variable interpolate?',
      );
    }
    const cacheTtlSeconds = Math.max(1, Math.round(parseDuration(opts.cacheTtl) / 1000));
    const endpoint = opts.development ? DEVELOPMENT_URL : PRODUCTION_URL;

    let signingKey: Promise<CryptoKey> | null = null;
    let cachedJwt: { value: string; issuedAtMs: number } | null = null;

    const bearerJwt = async (nowMs: number): Promise<string> => {
      if (cachedJwt !== null && nowMs - cachedJwt.issuedAtMs < JWT_REUSE_MS) {
        return cachedJwt.value;
      }
      signingKey ??= importPKCS8(opts.privateKey, "ES256");
      const value = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: opts.keyId })
        .setIssuer(opts.teamId)
        .setIssuedAt(Math.floor(nowMs / 1000))
        .sign(await signingKey);
      cachedJwt = { value, issuedAtMs: nowMs };
      return value;
    };

    return {
      type: "apple-device-check",
      name: opts.name ?? "apple-device-check",
      async verify(request: Request, ctx: VerifyContext) {
        const token = request.headers.get(opts.header);
        if (token === null || token === "") return null;

        const tokenHash = hex(await sha256(utf8(token)));
        const cacheKey = `dc:${tokenHash}`;
        const identity = {
          provider: "apple-device-check",
          deviceId: tokenHash.slice(0, 32),
          claims: {},
        };
        if ((await ctx.storage.get(cacheKey)) === "ok") {
          return { ok: true as const, identity };
        }

        let jwt: string;
        try {
          jwt = await bearerJwt(ctx.now());
        } catch (error) {
          ctx.log.error("apple-device-check: failed to sign API JWT", { error: String(error) });
          return { ok: false as const, reason: "device check unavailable" };
        }

        let response: Response;
        try {
          response = await ctx.fetch(endpoint, {
            method: "POST",
            headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
            body: JSON.stringify({
              device_token: token,
              transaction_id: crypto.randomUUID(),
              timestamp: ctx.now(),
            }),
          });
        } catch (error) {
          ctx.log.warn("apple-device-check: request to Apple failed", { error: String(error) });
          return { ok: false as const, reason: "device check unavailable" };
        }

        if (response.ok) {
          await ctx.storage.put(cacheKey, "ok", { ttlSeconds: cacheTtlSeconds });
          return { ok: true as const, identity };
        }
        if (response.status >= 500) {
          return { ok: false as const, reason: "device check unavailable" };
        }
        const detail = (await response.text().catch(() => "")).slice(0, 256);
        return {
          ok: false as const,
          status: 401,
          reason: `Apple rejected the device token (HTTP ${response.status}${
            detail === "" ? "" : `: ${detail}`
          })`,
        };
      },
    };
  },
};
