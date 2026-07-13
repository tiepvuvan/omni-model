import { decode as cborDecode } from "cbor2";
import { z } from "zod";
import { badRequest, ConfigError, OmniError } from "../../errors.js";
import type { RuntimeContext } from "../../types.js";
import { parseDuration } from "../../util/duration.js";
import type {
  AuthResult,
  AuthRoute,
  AuthVerifier,
  AuthVerifierFactory,
  VerifyContext,
} from "../types.js";
import {
  b64Decode,
  b64Encode,
  b64UrlEncode,
  bytesEqual,
  concatBytes,
  derSignatureToRaw,
  readUint32BE,
  sha256,
  utf8,
} from "./bytes.js";
import { X509Certificate } from "./x509.js";

/**
 * Apple App Attestation Root CA (ECC P-384, CN "Apple App Attestation Root
 * CA"), from https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem.
 * All attestation certificate chains must terminate at this anchor unless
 * `rootCaPem` overrides it (tests).
 */
const APPLE_APP_ATTESTATION_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

/** Certificate extension carrying the expected attestation nonce. */
const NONCE_EXTENSION_OID = "1.2.840.113635.100.8.2";

/** AAGUID values Apple stamps into attestation authenticator data. */
const AAGUID_PRODUCTION = utf8("appattest\x00\x00\x00\x00\x00\x00\x00");
const AAGUID_DEVELOPMENT = utf8("appattestdevelop");

const CHALLENGE_KEY_PREFIX = "aa:ch:";
const CHALLENGE_CLAIM_PREFIX = "aa:used:";
const KEY_KEY_PREFIX = "aa:key:";

const optionsSchema = z.strictObject({
  type: z.literal("apple-app-attest").optional(),
  name: z.string().min(1).optional(),
  /** Apple Developer team identifier; appId = `<teamId>.<bundleId>`. */
  teamId: z.string().min(1),
  bundleId: z.string().min(1),
  /** Which App Attest environment produced the keys (checked via AAGUID). */
  environment: z.enum(["production", "development"]).default("production"),
  /** Lifetime of issued challenges ("5m", "30s", ...). */
  challengeTtl: z.string().default("5m"),
  /** Trust-anchor override for tests; defaults to Apple's published root. */
  rootCaPem: z.string().optional(),
  keyIdHeader: z.string().min(1).default("x-appattest-keyid"),
  assertionHeader: z.string().min(1).default("x-appattest-assertion"),
  challengeHeader: z.string().min(1).default("x-appattest-challenge"),
});

/** Registered credential persisted at `aa:key:<keyId>`. */
interface StoredKey {
  /** base64 SPKI of the attested P-256 public key. */
  spki: string;
  /** Last accepted sign counter (initial value from the attestation). */
  counter: number;
}

/** CBOR values decode as objects (string keys) or Maps; accept both. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value instanceof Map) {
    const record: Record<string, unknown> = {};
    for (const [key, entry] of value) {
      if (typeof key !== "string") return null;
      record[key] = entry;
    }
    return record;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asBytes(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

function decodeBase64(value: string, what: string): Uint8Array {
  try {
    return b64Decode(value);
  } catch {
    throw badRequest(`${what} is not valid base64`);
  }
}

/**
 * Authenticator data of an attestation: 32-byte rpIdHash, 1 flags byte,
 * 4-byte big-endian counter, 16-byte AAGUID, 2-byte credentialId length,
 * credentialId.
 */
interface AttestedCredentialData {
  rpIdHash: Uint8Array;
  counter: number;
  aaguid: Uint8Array;
  credentialId: Uint8Array;
}

function parseAttestationAuthData(authData: Uint8Array): AttestedCredentialData {
  if (authData.length < 55) throw badRequest("attestation authenticator data is too short");
  const credentialIdLength = ((authData[53] ?? 0) << 8) | (authData[54] ?? 0);
  if (authData.length < 55 + credentialIdLength) {
    throw badRequest("attestation authenticator data is truncated");
  }
  return {
    rpIdHash: authData.subarray(0, 32),
    counter: readUint32BE(authData, 33),
    aaguid: authData.subarray(37, 53),
    credentialId: authData.subarray(55, 55 + credentialIdLength),
  };
}

/**
 * Extract the uncompressed EC point from a P-256 SubjectPublicKeyInfo. For
 * EC keys the point is the tail of the BIT STRING, i.e. the final 65 bytes
 * (0x04 || X || Y) of the SPKI encoding.
 */
function uncompressedPointFromSpki(spki: Uint8Array): Uint8Array {
  if (spki.length < 65) throw badRequest("credential certificate public key is not P-256");
  const point = spki.subarray(spki.length - 65);
  if (point[0] !== 0x04) {
    throw badRequest("credential certificate public key is not an uncompressed P-256 point");
  }
  return point;
}

/**
 * Apple App Attest verifier.
 *
 * Registration (`POST /auth/app-attest/register`) implements the checks from
 * Apple's "Validating apps that connect to your server":
 *  1. certificate chain from the credential certificate to the Apple App
 *     Attestation Root CA (signatures pairwise, validity windows at ctx.now),
 *  2. nonce = SHA-256(authData || SHA-256(challenge)) matches the trailing
 *     32 bytes of certificate extension OID 1.2.840.113635.100.8.2,
 *  3. keyId == SHA-256(credential certificate's uncompressed public key),
 *  4. rpIdHash == SHA-256(appId),
 *  5. AAGUID matches the configured environment,
 *  6. credentialId == keyId,
 * then stores the credential public key (SPKI) and initial counter.
 *
 * Per-request assertions are checked per "Verify the assertion": the
 * DER-encoded ECDSA signature must verify over
 * SHA-256(authenticatorData || SHA-256(challenge)) with the registered key,
 * rpIdHash must match the appId, the counter must strictly increase, and the
 * challenge is single-use (deleted after a successful verify).
 */
export const appleAppAttestVerifierFactory: AuthVerifierFactory = {
  type: "apple-app-attest",
  create(options: Record<string, unknown>, _runtime: RuntimeContext): AuthVerifier {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ConfigError(`apple-app-attest: ${z.prettifyError(parsed.error)}`);
    }
    const opts = parsed.data;
    const challengeTtlSeconds = Math.max(1, Math.round(parseDuration(opts.challengeTtl) / 1000));
    const appId = `${opts.teamId}.${opts.bundleId}`;
    const expectedAaguid =
      opts.environment === "production" ? AAGUID_PRODUCTION : AAGUID_DEVELOPMENT;

    let rootCa: X509Certificate;
    try {
      rootCa = new X509Certificate(opts.rootCaPem ?? APPLE_APP_ATTESTATION_ROOT_CA_PEM);
    } catch (error) {
      throw new ConfigError(
        `apple-app-attest: rootCaPem is not a valid certificate (${String(error)})`,
      );
    }

    let appIdHashPromise: Promise<Uint8Array> | null = null;
    const appIdHash = (): Promise<Uint8Array> => {
      appIdHashPromise ??= sha256(utf8(appId));
      return appIdHashPromise;
    };

    /**
     * Verify the x5c chain terminates at the trusted root: pairwise signature
     * checks plus validity-window checks against ctx.now(). Returns the
     * credential (leaf) certificate.
     */
    const verifyChain = async (x5c: Uint8Array[], nowMs: number): Promise<X509Certificate> => {
      let certs: X509Certificate[];
      try {
        certs = x5c.map((der) => new X509Certificate(der as Uint8Array<ArrayBuffer>));
      } catch {
        throw badRequest("attestation x5c contains an unparseable certificate");
      }
      const rootRaw = new Uint8Array(rootCa.rawData);
      // Some clients include the root itself; drop it so the anchor is always ours.
      while (
        certs.length > 0 &&
        bytesEqual(new Uint8Array(certs[certs.length - 1]?.rawData ?? new ArrayBuffer(0)), rootRaw)
      ) {
        certs.pop();
      }
      if (certs.length === 0) throw badRequest("attestation x5c is empty");
      const chain = [...certs, rootCa];
      const now = new Date(nowMs);
      for (let i = 0; i < chain.length; i++) {
        const cert = chain[i] as X509Certificate;
        if (now < cert.notBefore || now > cert.notAfter) {
          throw badRequest("attestation certificate is expired or not yet valid");
        }
        const issuer = chain[i + 1];
        if (issuer === undefined) continue;
        const signatureOk = await cert
          .verify({ publicKey: issuer, signatureOnly: true })
          .catch(() => false);
        if (!signatureOk) {
          throw badRequest("attestation certificate chain does not verify to the Apple root");
        }
      }
      return certs[0] as X509Certificate;
    };

    const registerAttestation = async (request: Request, ctx: VerifyContext): Promise<Response> => {
      let body: Record<string, unknown> | null = null;
      try {
        body = asRecord(await request.json());
      } catch {
        throw badRequest("register body must be JSON");
      }
      if (body === null) throw badRequest("register body must be a JSON object");
      const { keyId, attestation, challenge } = body;
      if (
        typeof keyId !== "string" ||
        typeof attestation !== "string" ||
        typeof challenge !== "string"
      ) {
        throw badRequest(
          'register body requires string fields "keyId", "attestation" and "challenge"',
        );
      }
      if ((await ctx.storage.get(CHALLENGE_KEY_PREFIX + challenge)) === null) {
        throw badRequest("unknown or expired challenge — request a new one first");
      }

      const attestationBytes = decodeBase64(attestation, "attestation");
      const keyIdBytes = decodeBase64(keyId, "keyId");
      let decoded: unknown;
      try {
        decoded = cborDecode(attestationBytes);
      } catch {
        throw badRequest("attestation is not valid CBOR");
      }
      const attestationObj = asRecord(decoded);
      if (attestationObj === null) throw badRequest("attestation must be a CBOR map");
      if (attestationObj.fmt !== "apple-appattest") {
        throw badRequest('attestation fmt must be "apple-appattest"');
      }
      const attStmt = asRecord(attestationObj.attStmt);
      const authData = asBytes(attestationObj.authData);
      if (attStmt === null || authData === null) {
        throw badRequest("attestation is missing attStmt or authData");
      }
      const x5cRaw = attStmt.x5c;
      if (!Array.isArray(x5cRaw) || x5cRaw.length === 0) {
        throw badRequest("attestation attStmt.x5c must be a non-empty certificate array");
      }
      const x5c: Uint8Array[] = [];
      for (const der of x5cRaw) {
        const bytes = asBytes(der);
        if (bytes === null) throw badRequest("attestation x5c entries must be byte strings");
        x5c.push(bytes);
      }

      // (b) chain of trust up to the Apple App Attestation Root CA.
      const credCert = await verifyChain(x5c, ctx.now());

      // (c)+(d) nonce binding: the certificate must embed
      // SHA-256(authData || SHA-256(challenge)) in extension OID
      // 1.2.840.113635.100.8.2 (trailing 32 bytes of the DER payload).
      const clientDataHash = await sha256(utf8(challenge));
      const nonce = await sha256(concatBytes(authData, clientDataHash));
      const nonceExtension = credCert.getExtension(NONCE_EXTENSION_OID);
      if (nonceExtension === null) {
        throw badRequest("credential certificate is missing the App Attest nonce extension");
      }
      const extensionValue = new Uint8Array(nonceExtension.value);
      if (
        extensionValue.length < nonce.length ||
        !bytesEqual(extensionValue.subarray(extensionValue.length - nonce.length), nonce)
      ) {
        throw badRequest("attestation nonce does not match the challenge");
      }

      // (e) key identifier: keyId == SHA-256(uncompressed public key point).
      const spki = new Uint8Array(credCert.publicKey.rawData);
      const publicKeyHash = await sha256(uncompressedPointFromSpki(spki));
      if (!bytesEqual(publicKeyHash, keyIdBytes)) {
        throw badRequest("keyId does not match the attested public key");
      }

      // (e) authenticator data: rpIdHash, environment AAGUID, credentialId.
      const authFields = parseAttestationAuthData(authData);
      if (!bytesEqual(authFields.rpIdHash, await appIdHash())) {
        throw badRequest("attestation rpIdHash does not match the configured appId");
      }
      if (!bytesEqual(authFields.aaguid, expectedAaguid)) {
        throw badRequest(`attestation AAGUID does not match the ${opts.environment} environment`);
      }
      if (!bytesEqual(authFields.credentialId, keyIdBytes)) {
        throw badRequest("attestation credentialId does not match keyId");
      }

      // (f) persist the credential; the attestation's counter is the baseline.
      const stored: StoredKey = { spki: b64Encode(spki), counter: authFields.counter };
      await ctx.storage.put(KEY_KEY_PREFIX + keyId, JSON.stringify(stored));
      await ctx.storage.delete(CHALLENGE_KEY_PREFIX + challenge);
      return Response.json({ registered: true });
    };

    const routes: AuthRoute[] = [
      {
        method: "POST",
        path: "/auth/app-attest/challenge",
        handler: async (_request, ctx) => {
          const bytes = new Uint8Array(32);
          crypto.getRandomValues(bytes);
          const challenge = b64UrlEncode(bytes);
          await ctx.storage.put(CHALLENGE_KEY_PREFIX + challenge, "1", {
            ttlSeconds: challengeTtlSeconds,
          });
          return Response.json({ challenge });
        },
      },
      {
        method: "POST",
        path: "/auth/app-attest/register",
        handler: async (request, ctx) => {
          try {
            return await registerAttestation(request, ctx);
          } catch (error) {
            if (error instanceof OmniError) return error.toResponse();
            ctx.log.error("apple-app-attest: registration failed unexpectedly", {
              error: String(error),
            });
            return badRequest("App Attest registration failed").toResponse();
          }
        },
      },
    ];

    const fail = (reason: string): AuthResult => ({ ok: false, status: 401, reason });

    return {
      type: "apple-app-attest",
      name: opts.name ?? "apple-app-attest",
      routes,
      async verify(request: Request, ctx: VerifyContext) {
        const keyId = request.headers.get(opts.keyIdHeader);
        const assertion = request.headers.get(opts.assertionHeader);
        const challenge = request.headers.get(opts.challengeHeader);
        if (keyId === null && assertion === null && challenge === null) return null;
        if (keyId === null || assertion === null || challenge === null) {
          return fail("App Attest requires keyId, assertion and challenge headers");
        }

        const storedRaw = await ctx.storage.get(KEY_KEY_PREFIX + keyId);
        if (storedRaw === null) return fail("unknown App Attest key — register first");
        let stored: StoredKey;
        try {
          const record = asRecord(JSON.parse(storedRaw));
          if (
            record === null ||
            typeof record.spki !== "string" ||
            typeof record.counter !== "number"
          ) {
            throw new Error("bad record");
          }
          stored = { spki: record.spki, counter: record.counter };
        } catch {
          return fail("stored App Attest key is corrupt — register again");
        }

        if ((await ctx.storage.get(CHALLENGE_KEY_PREFIX + challenge)) === null) {
          return fail("unknown or expired App Attest challenge");
        }

        // Atomically claim the challenge BEFORE the (async, yielding) signature
        // and counter checks. Without this, N concurrent replays of a single
        // captured assertion all read the same challenge/counter, all pass, and
        // all delete the challenge at the end — a TOCTOU that defeats single-use.
        // `increment` is the storage layer's atomic primitive: exactly one
        // caller sees the post-increment value 1, so only the first replay wins.
        // (On eventually-consistent backends like Cloudflare KV this is
        // best-effort per the CounterStore contract; use durable-object/redis/
        // postgres storage for strict App Attest replay protection.)
        const claim = await ctx.storage.increment(
          CHALLENGE_CLAIM_PREFIX + challenge,
          1,
          challengeTtlSeconds,
        );
        if (claim !== 1) return fail("App Attest challenge already used");

        let signature: Uint8Array | null = null;
        let authenticatorData: Uint8Array | null = null;
        try {
          const decoded = asRecord(cborDecode(b64Decode(assertion)));
          if (decoded !== null) {
            signature = asBytes(decoded.signature);
            authenticatorData = asBytes(decoded.authenticatorData);
          }
        } catch {
          // handled below
        }
        if (signature === null || authenticatorData === null) {
          return fail("assertion must be CBOR with signature and authenticatorData");
        }
        if (authenticatorData.length < 37) return fail("assertion authenticator data is too short");

        // Signature over nonce = SHA-256(authenticatorData || SHA-256(challenge)).
        const clientDataHash = await sha256(utf8(challenge));
        const nonce = await sha256(concatBytes(authenticatorData, clientDataHash));
        let rawSignature: Uint8Array<ArrayBuffer>;
        try {
          rawSignature = derSignatureToRaw(signature);
        } catch {
          return fail("assertion signature is not DER-encoded ECDSA");
        }
        let publicKey: CryptoKey;
        try {
          publicKey = await crypto.subtle.importKey(
            "spki",
            b64Decode(stored.spki),
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["verify"],
          );
        } catch {
          return fail("stored App Attest key is corrupt — register again");
        }
        const signatureOk = await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          publicKey,
          rawSignature,
          nonce,
        );
        if (!signatureOk) return fail("invalid App Attest assertion signature");

        if (!bytesEqual(authenticatorData.subarray(0, 32), await appIdHash())) {
          return fail("assertion rpIdHash does not match the configured appId");
        }

        // Counter must strictly increase to block assertion replay.
        const counter = readUint32BE(authenticatorData, 33);
        if (counter <= stored.counter) return fail("assertion counter replay detected");
        const updated: StoredKey = { spki: stored.spki, counter };
        await ctx.storage.put(KEY_KEY_PREFIX + keyId, JSON.stringify(updated));

        // Challenges are single-use.
        await ctx.storage.delete(CHALLENGE_KEY_PREFIX + challenge);

        return {
          ok: true as const,
          identity: { provider: "apple-app-attest", deviceId: keyId, claims: {} },
        };
      },
    };
  },
};
