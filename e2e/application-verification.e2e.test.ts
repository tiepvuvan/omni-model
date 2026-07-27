import { createHmac } from "node:crypto";
import { googlePlayIntegrityRequestHash } from "@omni-model/core";
import { type RunningServer, startServer } from "@omni-model/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const JWT_SECRET = "unit-e2e-jwt-secret-that-is-long-enough-for-hs256";
const CHAT_BODY = JSON.stringify({
  model: "smart",
  messages: [{ role: "user", content: "hello" }],
});

let server: RunningServer;
let userToken: string;
const calls: string[] = [];

function signUserToken(nowSeconds: number): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: "user-1",
    plan: "test",
    iat: nowSeconds,
    exp: nowSeconds + 3_600,
  })}`;
  const signature = createHmac("sha256", JWT_SECRET).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function completion(): Response {
  return Response.json({
    id: "chatcmpl-upstream",
    object: "chat.completion",
    created: 1_750_000_000,
    model: "upstream-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "verified" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
}

beforeAll(async () => {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  userToken = signUserToken(nowSeconds);

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes("challenges.cloudflare.com/turnstile/v0/siteverify")) {
      const body = JSON.parse(String(init?.body)) as { response: string };
      return Response.json(
        body.response === "bad-turnstile"
          ? { success: false, "error-codes": ["invalid-input-response"] }
          : { success: true, hostname: "app.example.com", action: "chat" },
      );
    }
    if (url.includes("recaptchaenterprise.googleapis.com")) {
      return Response.json({
        tokenProperties: {
          valid: true,
          hostname: "app.example.com",
          action: "chat",
        },
        riskAnalysis: { score: 0.9, reasons: [] },
      });
    }
    if (url.includes("playintegrity.googleapis.com")) {
      const requestHash = await googlePlayIntegrityRequestHash(
        "POST",
        "/v1/chat/completions",
        new TextEncoder().encode(CHAT_BODY),
      );
      return Response.json({
        tokenPayloadExternal: {
          requestDetails: {
            requestPackageName: "com.example.app",
            requestHash,
            timestampMillis: String(Date.now()),
          },
          appIntegrity: {
            appRecognitionVerdict: "PLAY_RECOGNIZED",
            packageName: "com.example.app",
            certificateSha256Digest: ["cert-a"],
          },
          deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
          accountDetails: { appLicensingVerdict: "LICENSED" },
        },
      });
    }
    if (url.startsWith("https://upstream.test/v1/chat/completions")) return completion();
    throw new Error(`unexpected outbound request: ${url}`);
  };

  server = await startServer({
    port: 0,
    hostname: "127.0.0.1",
    fetch: fetchImpl,
    getGoogleAccessToken: vi.fn(async () => "google-access-token"),
    config: {
      version: 1,
      storage: { type: "memory" },
      server: { logLevel: "silent" },
      security: {
        userAuth: { type: "jwt", secret: JWT_SECRET, algorithms: ["HS256"] },
        appAuth: {
          mode: "any",
          providers: [
            {
              type: "cloudflare-turnstile",
              secret: "turnstile-secret",
              action: "chat",
              hostnames: ["app.example.com"],
            },
            {
              type: "recaptcha-enterprise",
              projectId: "risk-project",
              siteKey: "site-key",
              apiKey: "recaptcha-api-key",
              expectedAction: "chat",
              minScore: 0.7,
              hostnames: ["app.example.com"],
            },
            {
              type: "google-play-integrity",
              packageName: "com.example.app",
              certificateSha256Digests: ["cert-a"],
              requireLicensed: true,
            },
          ],
        },
      },
      routing: {
        rules: [
          {
            id: "default",
            when: "true",
            target: { type: "openai-compatible", baseUrl: "https://upstream.test/v1" },
          },
        ],
      },
    },
  });
});

afterAll(async () => {
  await server.close();
});

async function chat(appHeader: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${userToken}`,
      "content-type": "application/json",
      ...appHeader,
    },
    body: CHAT_BODY,
  });
}

describe("application verification through the running container server", () => {
  it.each([
    ["Turnstile", { "x-turnstile-token": "turnstile-token" }],
    ["reCAPTCHA Enterprise", { "x-recaptcha-token": "recaptcha-token" }],
    ["Play Integrity", { "x-google-play-integrity": "play-token" }],
  ])("accepts a %s proof and reaches the model upstream", async (_name, header) => {
    const response = await chat(header);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("verified");
  });

  it("rejects an invalid proof before the model upstream", async () => {
    const upstreamCalls = calls.filter((url) => url.includes("upstream.test")).length;
    const response = await chat({ "x-turnstile-token": "bad-turnstile" });
    expect(response.status).toBe(401);
    expect(calls.filter((url) => url.includes("upstream.test"))).toHaveLength(upstreamCalls);
  });
});
