import { encode as cborEncode } from "cbor2";
import {
  b64Encode,
  concatBytes,
  rawSignatureToDer,
  sha256,
  utf8,
} from "../../../src/auth/apple/bytes.js";
import * as x509 from "../../../src/auth/apple/x509.js";
import type { VerifyContext } from "../../../src/auth/types.js";
import { silentLogger } from "../../../src/logging.js";
import { MemoryStorageAdapter } from "../../../src/storage/memory.js";

export const FIXED_NOW = new Date("2026-06-01T00:00:00Z").getTime();

export interface TestCtx extends VerifyContext {
  storage: MemoryStorageAdapter;
}

/** Deterministic offline VerifyContext for verifier tests. */
export function makeCtx(overrides: { fetch?: typeof fetch; now?: () => number } = {}): TestCtx {
  const now = overrides.now ?? (() => FIXED_NOW);
  return {
    env: {},
    fetch:
      overrides.fetch ??
      (async () => {
        throw new Error("unexpected network call");
      }),
    now,
    waitUntil: () => {},
    log: silentLogger,
    storage: new MemoryStorageAdapter(now),
  };
}

const EC_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

export interface FakeAppleCa {
  rootPem: string;
  rootKeys: CryptoKeyPair;
}

/** Generate a fake P-384 "Apple App Attestation Root CA" for offline tests. */
export async function makeFakeRoot(name = "Fake App Attest Root"): Promise<FakeAppleCa> {
  const rootKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, [
    "sign",
    "verify",
  ]);
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    name: `CN=${name}`,
    serialNumber: "01",
    notBefore: new Date("2025-01-01T00:00:00Z"),
    notAfter: new Date("2045-01-01T00:00:00Z"),
    keys: rootKeys,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-384" },
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  return { rootPem: root.toString("pem"), rootKeys };
}

export const AAGUID_PRODUCTION = utf8("appattest\x00\x00\x00\x00\x00\x00\x00");
export const AAGUID_DEVELOPMENT = utf8("appattestdevelop");

export interface AttestationOptions {
  ca: FakeAppleCa;
  challenge: string;
  appId: string;
  aaguid?: Uint8Array;
  counter?: number;
  /** Override the credentialId embedded in authData (defaults to the key id). */
  credentialId?: Uint8Array;
  /** Override the nonce embedded in the certificate extension. */
  nonceOverride?: Uint8Array;
  fmt?: string;
  notBefore?: Date;
  notAfter?: Date;
}

export interface AttestationFixture {
  /** base64 keyId (SHA-256 of the credential public key point). */
  keyId: string;
  keyIdBytes: Uint8Array;
  /** base64 CBOR attestation object. */
  attestation: string;
  leafKeys: CryptoKeyPair;
  authData: Uint8Array;
}

/** Build a spec-shaped App Attest attestation signed by the fake root. */
export async function buildAttestation(options: AttestationOptions): Promise<AttestationFixture> {
  const leafKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const point = new Uint8Array(await crypto.subtle.exportKey("raw", leafKeys.publicKey));
  const keyIdBytes = await sha256(point);

  const rpIdHash = await sha256(utf8(options.appId));
  const counter = options.counter ?? 0;
  const aaguid = options.aaguid ?? AAGUID_PRODUCTION;
  const credentialId = options.credentialId ?? keyIdBytes;
  const authData = concatBytes(
    rpIdHash,
    new Uint8Array([0x40]),
    new Uint8Array([
      (counter >>> 24) & 0xff,
      (counter >>> 16) & 0xff,
      (counter >>> 8) & 0xff,
      counter & 0xff,
    ]),
    aaguid,
    new Uint8Array([(credentialId.length >>> 8) & 0xff, credentialId.length & 0xff]),
    credentialId,
  );

  const clientDataHash = await sha256(utf8(options.challenge));
  const nonce = options.nonceOverride ?? (await sha256(concatBytes(authData, clientDataHash)));
  // DER: SEQUENCE { [1] { OCTET STRING (nonce) } } — how Apple wraps the nonce.
  const extensionValue = concatBytes(
    new Uint8Array([0x30, nonce.length + 4, 0xa1, nonce.length + 2, 0x04, nonce.length]),
    nonce,
  );

  const rootCert = new x509.X509Certificate(options.ca.rootPem);
  const leafCert = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    subject: "CN=Test credential",
    issuer: rootCert.subject,
    notBefore: options.notBefore ?? new Date("2026-01-01T00:00:00Z"),
    notAfter: options.notAfter ?? new Date("2027-01-01T00:00:00Z"),
    publicKey: leafKeys.publicKey,
    signingKey: options.ca.rootKeys.privateKey,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-384" },
    extensions: [new x509.Extension("1.2.840.113635.100.8.2", false, extensionValue)],
  });

  const attestationBytes = cborEncode({
    fmt: options.fmt ?? "apple-appattest",
    attStmt: { x5c: [new Uint8Array(leafCert.rawData)], receipt: new Uint8Array(0) },
    authData,
  });
  return {
    keyId: b64Encode(keyIdBytes),
    keyIdBytes,
    attestation: b64Encode(attestationBytes),
    leafKeys,
    authData,
  };
}

export interface AssertionOptions {
  challenge: string;
  appId: string;
  counter: number;
  signingKey: CryptoKey;
  /** Override the rpIdHash in authenticatorData. */
  rpIdHashOverride?: Uint8Array;
  /** Corrupt the signature after signing. */
  tamperSignature?: boolean;
}

/** Build a base64 CBOR assertion the way an attested device would. */
export async function buildAssertion(options: AssertionOptions): Promise<string> {
  const rpIdHash = options.rpIdHashOverride ?? (await sha256(utf8(options.appId)));
  const counter = options.counter;
  const authenticatorData = concatBytes(
    rpIdHash,
    new Uint8Array([0x40]),
    new Uint8Array([
      (counter >>> 24) & 0xff,
      (counter >>> 16) & 0xff,
      (counter >>> 8) & 0xff,
      counter & 0xff,
    ]),
  );
  const clientDataHash = await sha256(utf8(options.challenge));
  const nonce = await sha256(concatBytes(authenticatorData, clientDataHash));
  const rawSignature = new Uint8Array(await crypto.subtle.sign(EC_SIGN, options.signingKey, nonce));
  if (options.tamperSignature === true) {
    rawSignature[10] = (rawSignature[10] ?? 0) ^ 0xff;
  }
  const signature = rawSignatureToDer(rawSignature);
  return b64Encode(cborEncode({ signature, authenticatorData }));
}

/** Generate a fresh P-256 key and return it as a PKCS8 PEM (.p8 style). */
export async function makePkcs8Pem(): Promise<string> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const body = b64Encode(pkcs8)
    .replace(/(.{64})/g, "$1\n")
    .trimEnd();
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}
