import { createSign, generateKeyPairSync } from "node:crypto";
import { type RunningServer, startServer } from "@omni-model/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLERK_ISSUER = "https://helpful-otter.clerk.accounts.dev";
const COGNITO_REGION = "us-east-1";
const COGNITO_POOL = "us-east-1_Example";
const COGNITO_CLIENT = "app-client-id";
const COGNITO_ISSUER = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_POOL}`;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const jwk = {
  ...(publicKey.export({ format: "jwk" }) as JsonWebKey),
  kid: "e2e-rsa-key",
  alg: "RS256",
  use: "sig",
};
const CHAT_BODY = JSON.stringify({
  model: "smart",
  messages: [{ role: "user", content: "hello" }],
});

let clerkServer: RunningServer;
let cognitoServer: RunningServer;
let upstreamCalls = 0;

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(payload: Record<string, unknown>, typ?: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const unsigned = `${encode({
    alg: "RS256",
    kid: "e2e-rsa-key",
    ...(typ === undefined ? {} : { typ }),
  })}.${encode({ iat: now - 5, exp: now + 3_600, ...payload })}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(privateKey)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

function completion(): Response {
  upstreamCalls += 1;
  return Response.json({
    id: "chatcmpl-user-auth-e2e",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model: "upstream-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "authenticated" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
}

const fetchImpl: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (
    url === `${CLERK_ISSUER}/.well-known/jwks.json` ||
    url === `${COGNITO_ISSUER}/.well-known/jwks.json`
  ) {
    return Response.json({ keys: [jwk] });
  }
  if (url === "https://upstream.test/v1/chat/completions") return completion();
  throw new Error(`unexpected outbound request: ${url}`);
};

function config(userAuth: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    storage: { type: "memory" },
    server: { logLevel: "silent" },
    security: { userAuth },
    routing: {
      rules: [
        {
          id: "default",
          when: "true",
          target: { type: "openai-compatible", baseUrl: "https://upstream.test/v1" },
        },
      ],
    },
  };
}

beforeAll(async () => {
  clerkServer = await startServer({
    port: 0,
    hostname: "127.0.0.1",
    fetch: fetchImpl,
    config: config({
      type: "clerk",
      issuer: CLERK_ISSUER,
      authorizedParties: ["https://app.example.com"],
    }),
  });
  cognitoServer = await startServer({
    port: 0,
    hostname: "127.0.0.1",
    fetch: fetchImpl,
    config: config({
      type: "aws-cognito",
      region: COGNITO_REGION,
      userPoolId: COGNITO_POOL,
      clientIds: [COGNITO_CLIENT],
      requiredScopes: ["models:invoke"],
    }),
  });
});

afterAll(async () => {
  await Promise.all([clerkServer.close(), cognitoServer.close()]);
});

async function chat(
  server: RunningServer,
  header: "x-clerk-session-token" | "x-cognito-id-token",
  token: string,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [header]: token,
    },
    body: CHAT_BODY,
  });
}

describe("user authentication through the running container server", () => {
  it("accepts a Clerk session token and reaches the model upstream", async () => {
    const response = await chat(
      clerkServer,
      "x-clerk-session-token",
      sign(
        {
          iss: CLERK_ISSUER,
          sub: "user_clerk",
          sid: "sess_clerk",
          azp: "https://app.example.com",
        },
        "JWT",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "authenticated" } }],
    });
  });

  it("accepts a Cognito access token and reaches the model upstream", async () => {
    const response = await chat(
      cognitoServer,
      "x-cognito-id-token",
      sign({
        iss: COGNITO_ISSUER,
        sub: "user_cognito",
        token_use: "access",
        client_id: COGNITO_CLIENT,
        scope: "openid models:invoke",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "authenticated" } }],
    });
  });

  it("rejects a Cognito token for another client before model routing", async () => {
    const before = upstreamCalls;
    const response = await chat(
      cognitoServer,
      "x-cognito-id-token",
      sign({
        iss: COGNITO_ISSUER,
        sub: "user_cognito",
        token_use: "access",
        client_id: "other-client",
        scope: "models:invoke",
      }),
    );
    expect(response.status).toBe(401);
    expect(upstreamCalls).toBe(before);
  });
});
