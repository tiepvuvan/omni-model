import { describe, expect, it } from "vitest";
import type { AuthVerifier, Identity } from "../../src/auth/types.js";
import { isPublicPath, mergeIdentities } from "../../src/server/auth.js";
import { CHAT_BODY, chatRequest, createRecordingLogger, createTestApp } from "./helpers.js";

const AUTH_YAML = `
version: 1
security:
  providers:
    - type: fake-auth
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;

function verifier(name: string): AuthVerifier {
  return { type: "fake-auth", name, verify: async () => null };
}

describe("isPublicPath", () => {
  it("matches exact paths and trailing-* prefixes only", () => {
    expect(isPublicPath("/v1/models", ["/v1/models"])).toBe(true);
    expect(isPublicPath("/v1/models", ["/v1/model"])).toBe(false);
    expect(isPublicPath("/v1/public/anything", ["/v1/public/*"])).toBe(true);
    expect(isPublicPath("/v1/publicity", ["/v1/public*"])).toBe(true);
    expect(isPublicPath("/v1/chat/completions", ["/v1/public/*", "/healthz"])).toBe(false);
    expect(isPublicPath("/anything", [])).toBe(false);
  });
});

describe("mergeIdentities", () => {
  it("merges userId, deviceId, provider and namespaced claims", () => {
    const device: Identity = { provider: "app-check", deviceId: "d1", claims: { app: "ios" } };
    const user: Identity = {
      provider: "firebase-auth",
      userId: "u1",
      claims: { tier: "pro" },
    };
    const merged = mergeIdentities([
      { verifier: verifier("check"), identity: device },
      { verifier: verifier("auth"), identity: user },
    ]);
    expect(merged.userId).toBe("u1");
    expect(merged.deviceId).toBe("d1");
    // Provider comes from the identity that supplied the userId.
    expect(merged.provider).toBe("firebase-auth");
    // First identity's claims are flattened; every verifier is namespaced.
    expect(merged.claims).toEqual({
      app: "ios",
      check: { app: "ios" },
      auth: { tier: "pro" },
    });
  });

  it("falls back to the first identity's provider when no userId is set", () => {
    const a: Identity = { provider: "a", claims: {} };
    const b: Identity = { provider: "b", deviceId: "d2", claims: {} };
    const merged = mergeIdentities([
      { verifier: verifier("first"), identity: a },
      { verifier: verifier("second"), identity: b },
    ]);
    expect(merged.provider).toBe("a");
    expect(merged.deviceId).toBe("d2");
    expect(merged.userId).toBeUndefined();
  });
});

describe("auth middleware (mode: any)", () => {
  it("keeps /healthz public even with auth configured", async () => {
    const { app } = await createTestApp({ yaml: AUTH_YAML });
    const response = await app.fetch(new Request("http://local/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("rejects credential-less requests with 401 and WWW-Authenticate", async () => {
    const { app } = await createTestApp({ yaml: AUTH_YAML });
    const response = await app.fetch(chatRequest(CHAT_BODY));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    const body = (await response.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toBe("authentication required");
  });

  it("surfaces the verifier's rejection reason", async () => {
    const { app } = await createTestApp({ yaml: AUTH_YAML });
    const response = await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "bad" }));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("invalid credential for fake-auth");
  });

  it("authenticates and serves the request", async () => {
    const { app, providers } = await createTestApp({ yaml: AUTH_YAML });
    const response = await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "alice" }));
    expect(response.status).toBe(200);
    expect(providers.get("fake")?.chatCalls).toHaveLength(1);
  });

  it("tries the next verifier when the first sees no credential", async () => {
    const yaml = `
version: 1
security:
  providers:
    - type: fake-auth
      name: primary
      header: x-user-a
    - type: fake-auth
      name: secondary
      header: x-user-b
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    const { app } = await createTestApp({ yaml });
    const ok = await app.fetch(chatRequest(CHAT_BODY, { "x-user-b": "bob" }));
    expect(ok.status).toBe(200);

    // A later verifier's acceptance still wins over an earlier explicit failure.
    const mixed = await app.fetch(chatRequest(CHAT_BODY, { "x-user-a": "bad", "x-user-b": "bob" }));
    expect(mixed.status).toBe(200);

    // With only a bad credential, the remembered failure's reason surfaces.
    const failed = await app.fetch(chatRequest(CHAT_BODY, { "x-user-a": "bad" }));
    expect(failed.status).toBe(401);
    const body = (await failed.json()) as { error: { message: string } };
    expect(body.error.message).toBe("invalid credential for primary");
  });

  it("bypasses auth for configured publicPaths", async () => {
    const yaml = `
version: 1
security:
  publicPaths: ["/v1/models"]
  providers:
    - type: fake-auth
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    const { app } = await createTestApp({ yaml });
    const models = await app.fetch(new Request("http://local/v1/models"));
    expect(models.status).toBe(200);
    // Non-public /v1 paths still require credentials.
    const chat = await app.fetch(chatRequest(CHAT_BODY));
    expect(chat.status).toBe(401);
  });

  it("warns once at startup and serves openly when no verifiers are configured", async () => {
    const { logger, entries } = createRecordingLogger();
    const yaml = `
version: 1
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    const { app } = await createTestApp({ yaml, logger });
    const warnings = entries.filter((entry) => entry.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("no security providers configured");

    const response = await app.fetch(chatRequest(CHAT_BODY));
    expect(response.status).toBe(200);
  });
});

describe("auth middleware (mode: all)", () => {
  const ALL_YAML = `
version: 1
security:
  mode: all
  providers:
    - type: fake-auth
      name: primary
      header: x-user-a
    - type: fake-auth
      name: secondary
      header: x-user-b
      kind: device
providers:
  fake:
    type: fake
routing:
  routes:
    - name: merged-claims
      when: 'user.claims.tier == "pro" && device.id == "dev-1"'
      provider: fake
      model: merged-model
`;

  it("accepts when every verifier accepts and merges identities", async () => {
    const { app, providers } = await createTestApp({ yaml: ALL_YAML });
    const response = await app.fetch(
      chatRequest(CHAT_BODY, { "x-user-a": "pro", "x-user-b": "dev-1" }),
    );
    // The route only matches when merged claims AND merged device id are visible.
    expect(response.status).toBe(200);
    expect(providers.get("fake")?.chatCalls[0]?.request.model).toBe("merged-model");
  });

  it("rejects when any verifier sees no credential", async () => {
    const { app } = await createTestApp({ yaml: ALL_YAML });
    const response = await app.fetch(chatRequest(CHAT_BODY, { "x-user-a": "pro" }));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("credential missing for secondary");
  });

  it("rejects with the failing verifier's reason", async () => {
    const { app } = await createTestApp({ yaml: ALL_YAML });
    const response = await app.fetch(
      chatRequest(CHAT_BODY, { "x-user-a": "pro", "x-user-b": "bad" }),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("invalid credential for secondary");
  });
});
