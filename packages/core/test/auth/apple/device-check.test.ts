import { beforeAll, describe, expect, it } from "vitest";
import { b64Decode } from "../../../src/auth/apple/bytes.js";
import { appleDeviceCheckVerifierFactory } from "../../../src/auth/apple/device-check.js";
import { ConfigError } from "../../../src/errors.js";
import { FIXED_NOW, makeCtx, makePkcs8Pem, type TestCtx } from "./helpers.js";

let privateKey: string;

beforeAll(async () => {
  privateKey = await makePkcs8Pem();
});

function baseOptions(): Record<string, unknown> {
  return {
    type: "apple-device-check",
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    privateKey,
  };
}

interface RecordedCall {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

function recordingFetch(
  calls: RecordedCall[],
  respond: () => Response | Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return respond();
  }) as typeof fetch;
}

function deviceRequest(token?: string): Request {
  const headers = token === undefined ? {} : { "x-apple-device-token": token };
  return new Request("https://proxy.example/v1/chat/completions", { method: "POST", headers });
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64Decode(part))) as Record<string, unknown>;
}

async function verify(ctx: TestCtx, token?: string, options?: Record<string, unknown>) {
  const verifier = appleDeviceCheckVerifierFactory.create(options ?? baseOptions(), ctx);
  return verifier.verify(deviceRequest(token), ctx);
}

describe("appleDeviceCheckVerifierFactory", () => {
  it("has the expected type", () => {
    expect(appleDeviceCheckVerifierFactory.type).toBe("apple-device-check");
  });

  it("rejects invalid options at startup", () => {
    const ctx = makeCtx();
    expect(() => appleDeviceCheckVerifierFactory.create({ teamId: "T" }, ctx)).toThrow(ConfigError);
    expect(() =>
      appleDeviceCheckVerifierFactory.create({ ...baseOptions(), privateKey: "not-a-pem" }, ctx),
    ).toThrow(ConfigError);
    expect(() =>
      appleDeviceCheckVerifierFactory.create({ ...baseOptions(), cacheTtl: "5 parsecs" }, ctx),
    ).toThrow(ConfigError);
    expect(() =>
      appleDeviceCheckVerifierFactory.create({ ...baseOptions(), unexpected: true }, ctx),
    ).toThrow(ConfigError);
  });

  it("returns null when the device-token header is absent", async () => {
    const calls: RecordedCall[] = [];
    const ctx = makeCtx({ fetch: recordingFetch(calls, () => Response.json({}, { status: 200 })) });
    expect(await verify(ctx)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("validates a token with Apple and sends a well-formed request", async () => {
    const calls: RecordedCall[] = [];
    const ctx = makeCtx({ fetch: recordingFetch(calls, () => new Response("", { status: 200 })) });
    const result = await verify(ctx, "device-token-1");

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    if (result?.ok === true) {
      expect(result.identity.provider).toBe("apple-device-check");
      expect(result.identity.deviceId).toMatch(/^[0-9a-f]{32}$/);
      expect(result.identity.claims).toEqual({});
    }

    expect(calls).toHaveLength(1);
    const call = calls[0] as RecordedCall;
    expect(call.url).toBe("https://api.devicecheck.apple.com/v1/validate_device_token");
    expect(call.body.device_token).toBe("device-token-1");
    expect(call.body.timestamp).toBe(FIXED_NOW);
    expect(typeof call.body.transaction_id).toBe("string");
    expect((call.body.transaction_id as string).length).toBeGreaterThan(0);

    const bearer = call.authorization;
    expect(bearer).toMatch(/^Bearer /);
    const [headerPart, payloadPart, signaturePart] = (bearer as string).slice(7).split(".");
    expect(signaturePart).toBeTruthy();
    expect(decodeJwtPart(headerPart as string)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    const payload = decodeJwtPart(payloadPart as string);
    expect(payload.iss).toBe("TEAM123456");
    expect(payload.iat).toBe(Math.floor(FIXED_NOW / 1000));
  });

  it("caches successful validations and skips Apple on the next request", async () => {
    const calls: RecordedCall[] = [];
    const ctx = makeCtx({ fetch: recordingFetch(calls, () => new Response("", { status: 200 })) });
    const verifier = appleDeviceCheckVerifierFactory.create(baseOptions(), ctx);
    const first = await verifier.verify(deviceRequest("device-token-1"), ctx);
    const second = await verifier.verify(deviceRequest("device-token-1"), ctx);
    expect(first?.ok).toBe(true);
    expect(second?.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("reuses the API JWT for ~50 minutes, then re-signs", async () => {
    let nowMs = FIXED_NOW;
    const calls: RecordedCall[] = [];
    const ctx = makeCtx({
      fetch: recordingFetch(calls, () => new Response("", { status: 200 })),
      now: () => nowMs,
    });
    const verifier = appleDeviceCheckVerifierFactory.create(baseOptions(), ctx);

    await verifier.verify(deviceRequest("token-a"), ctx);
    nowMs = FIXED_NOW + 10 * 60_000;
    await verifier.verify(deviceRequest("token-b"), ctx);
    nowMs = FIXED_NOW + 51 * 60_000;
    await verifier.verify(deviceRequest("token-c"), ctx);

    expect(calls).toHaveLength(3);
    const [a, b, c] = calls as [RecordedCall, RecordedCall, RecordedCall];
    expect(b.authorization).toBe(a.authorization);
    expect(c.authorization).not.toBe(a.authorization);
    const payload = decodeJwtPart((c.authorization as string).slice(7).split(".")[1] as string);
    expect(payload.iat).toBe(Math.floor((FIXED_NOW + 51 * 60_000) / 1000));
  });

  it("rejects with Apple's error text on 4xx, without echoing the token", async () => {
    const calls: RecordedCall[] = [];
    const ctx = makeCtx({
      fetch: recordingFetch(
        calls,
        () => new Response("Missing or badly formatted authorization token", { status: 401 }),
      ),
    });
    const result = await verify(ctx, "secret-device-token");
    expect(result?.ok).toBe(false);
    if (result !== null && result.ok === false) {
      expect(result.reason).toContain("401");
      expect(result.reason).toContain("Missing or badly formatted authorization token");
      expect(result.reason).not.toContain("secret-device-token");
    }
  });

  it("does not cache failures", async () => {
    const calls: RecordedCall[] = [];
    const ctx = makeCtx({
      fetch: recordingFetch(calls, () => new Response("bad", { status: 400 })),
    });
    const verifier = appleDeviceCheckVerifierFactory.create(baseOptions(), ctx);
    await verifier.verify(deviceRequest("token-x"), ctx);
    await verifier.verify(deviceRequest("token-x"), ctx);
    expect(calls).toHaveLength(2);
  });

  it("maps Apple 5xx to a generic unavailable failure", async () => {
    const ctx = makeCtx({
      fetch: (async () => new Response("boom", { status: 500 })) as typeof fetch,
    });
    const result = await verify(ctx, "token-y");
    expect(result).toEqual({ ok: false, reason: "device check unavailable" });
  });

  it("maps network errors to a generic unavailable failure", async () => {
    const ctx = makeCtx({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    const result = await verify(ctx, "token-z");
    expect(result).toEqual({ ok: false, reason: "device check unavailable" });
  });

  it("uses the development endpoint when development: true", async () => {
    const calls: RecordedCall[] = [];
    const ctx = makeCtx({ fetch: recordingFetch(calls, () => new Response("", { status: 200 })) });
    await verify(ctx, "dev-token", { ...baseOptions(), development: true });
    expect((calls[0] as RecordedCall).url).toBe(
      "https://api.development.devicecheck.apple.com/v1/validate_device_token",
    );
  });

  it("honors a custom header name", async () => {
    const calls: RecordedCall[] = [];
    const ctx = makeCtx({ fetch: recordingFetch(calls, () => new Response("", { status: 200 })) });
    const verifier = appleDeviceCheckVerifierFactory.create(
      { ...baseOptions(), header: "x-device", name: "dc-custom" },
      ctx,
    );
    expect(verifier.name).toBe("dc-custom");
    const request = new Request("https://proxy.example/v1/chat/completions", {
      method: "POST",
      headers: { "x-device": "tok" },
    });
    const result = await verifier.verify(request, ctx);
    expect(result?.ok).toBe(true);
    // The default header alone is not recognized.
    expect(await verifier.verify(deviceRequest("tok"), ctx)).toBeNull();
  });
});
