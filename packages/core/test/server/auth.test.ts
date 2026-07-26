import { describe, expect, it } from "vitest";
import type { AuthVerifier, Identity } from "../../src/auth/types.js";
import { isPublicPath, mergeIdentities } from "../../src/server/auth.js";
import { CHAT_BODY, chatRequest, createTestApp } from "./helpers.js";

const AUTH_YAML = `
version: 1
security:
  userAuth:
    type: fake-auth
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
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

describe("layer 1: the user", () => {
  it("keeps /healthz public even with auth configured", async () => {
    const { app } = await createTestApp({ yaml: AUTH_YAML });
    expect((await app.fetch(new Request("http://local/healthz"))).status).toBe(200);
  });

  it("serves a request whose user credential is accepted", async () => {
    const { app, providers } = await createTestApp({ yaml: AUTH_YAML });
    const response = await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "alice" }));
    expect(response.status).toBe(200);
    expect(providers.get("fake")?.chatCalls).toHaveLength(1);
  });

  it("rejects a request that presents no user credential", async () => {
    // `null` from the user verifier is a rejection, not a fall-through: there is
    // nowhere else a user credential could come from, and a request with no user
    // has no budget to spend.
    const { app } = await createTestApp({ yaml: AUTH_YAML });
    const response = await app.fetch(chatRequest(CHAT_BODY));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("authentication required");
  });

  it("rejects with the verifier's own reason when the credential is invalid", async () => {
    const { app } = await createTestApp({ yaml: AUTH_YAML });
    const response = await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "bad" }));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("invalid credential for fake-auth");
  });

  it("bypasses auth for configured publicPaths", async () => {
    const yaml = `
version: 1
security:
  publicPaths: ["/v1/models"]
  userAuth:
    type: fake-auth
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`;
    const { app } = await createTestApp({ yaml });
    expect((await app.fetch(new Request("http://local/v1/models"))).status).toBe(200);
    // Non-public /v1 paths still require credentials.
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(401);
  });

  const NO_VERIFIER_YAML = `
version: 1
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`;

  it("refuses to start when no user authentication is configured", async () => {
    // A proxy that authenticates nobody is an open relay on the operator's
    // provider credits, and gives a caller nothing the upstream API doesn't.
    // Omitting `security` must not silently produce one.
    await expect(createTestApp({ yaml: NO_VERIFIER_YAML, injectVerifier: false })).rejects.toThrow(
      /security\.userAuth is not set/,
    );
  });

  it("offers a workable local-development config in the startup error", async () => {
    // The error has to be actionable: someone hitting this on their laptop
    // needs a verifier that works with no external service.
    await expect(createTestApp({ yaml: NO_VERIFIER_YAML, injectVerifier: false })).rejects.toThrow(
      /type: jwt/,
    );
  });

  it("has no opt-out: app attestation alone does not stand in for a user", async () => {
    // The tempting mistake: attest the app and call it authenticated. An attested
    // app still does not say *who* is calling, so there is nobody to bill.
    const yaml = `${NO_VERIFIER_YAML}security:
  appAuth:
    providers:
      - type: fake-app-auth
`;
    await expect(createTestApp({ yaml, injectVerifier: false })).rejects.toThrow(
      /security\.userAuth is not set/,
    );
  });

  it("refuses an app verifier configured as the user method, and says where it goes", async () => {
    const yaml = `${NO_VERIFIER_YAML}security:
  userAuth:
    type: fake-app-auth
`;
    await expect(createTestApp({ yaml, injectVerifier: false })).rejects.toThrow(
      /verifies an app or device, not a user.*security\.appAuth\.providers/s,
    );
  });

  it("refuses a user verifier configured in the app layer", async () => {
    const yaml = `${NO_VERIFIER_YAML}security:
  userAuth:
    type: fake-auth
  appAuth:
    providers:
      - type: fake-auth
`;
    await expect(createTestApp({ yaml, injectVerifier: false })).rejects.toThrow(
      /verifies a user, not an app/,
    );
  });
});

describe("layer 2: the app (mode: all)", () => {
  const LAYERED_YAML = `
version: 1
security:
  userAuth:
    type: fake-auth
    header: x-user-a
  appAuth:
    mode: all
    providers:
      - type: fake-app-auth
        name: attestation
        header: x-device-a
routing:
  rules:
    - { id: merged, name: merged, when: 'user.claims.tier == "pro" && device.id == "dev-1"', target: { type: fake, model: merged-model } }
`;

  it("accepts when both layers accept, and merges their identities", async () => {
    const { app, providers } = await createTestApp({ yaml: LAYERED_YAML });
    const response = await app.fetch(
      chatRequest(CHAT_BODY, { "x-user-a": "pro", "x-device-a": "dev-1" }),
    );

    // The rule only matches when the user's claims *and* the device id from the
    // app layer are both visible, which is what proves the merge.
    expect(response.status).toBe(200);
    expect(providers.get("merged")?.chatCalls[0]?.request.model).toBe("merged-model");
  });

  it("rejects when the app credential is absent", async () => {
    const { app } = await createTestApp({ yaml: LAYERED_YAML });
    const response = await app.fetch(chatRequest(CHAT_BODY, { "x-user-a": "pro" }));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("credential missing for attestation");
  });

  it("rejects with the app verifier's reason when its credential is invalid", async () => {
    const { app } = await createTestApp({ yaml: LAYERED_YAML });
    const response = await app.fetch(
      chatRequest(CHAT_BODY, { "x-user-a": "pro", "x-device-a": "bad" }),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("invalid attestation for attestation");
  });

  it("still requires the user, even with the app attested", async () => {
    const { app } = await createTestApp({ yaml: LAYERED_YAML });
    const response = await app.fetch(chatRequest(CHAT_BODY, { "x-device-a": "dev-1" }));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("authentication required");
  });
});

describe("layer 2: the app (mode: any)", () => {
  /*
   * Two schemes, one per platform, which is why `any` exists: an iOS client can
   * satisfy the Apple scheme and nothing else, and a web client the other. Under
   * `all` neither client could ever call.
   */
  const MULTI_PLATFORM_YAML = `
version: 1
security:
  userAuth:
    type: fake-auth
    header: x-user-a
  appAuth:
    mode: any
    providers:
      - type: fake-app-auth
        name: ios
        header: x-ios
      - type: fake-app-auth
        name: web
        header: x-web
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`;

  it("accepts a client that satisfies either scheme", async () => {
    const { app } = await createTestApp({ yaml: MULTI_PLATFORM_YAML });

    expect(
      (await app.fetch(chatRequest(CHAT_BODY, { "x-user-a": "alice", "x-ios": "dev-1" }))).status,
    ).toBe(200);
    expect(
      (await app.fetch(chatRequest(CHAT_BODY, { "x-user-a": "alice", "x-web": "session-1" })))
        .status,
    ).toBe(200);
  });

  it("accepts when a later scheme succeeds after an earlier one failed", async () => {
    const { app } = await createTestApp({ yaml: MULTI_PLATFORM_YAML });
    const response = await app.fetch(
      chatRequest(CHAT_BODY, { "x-user-a": "alice", "x-ios": "bad", "x-web": "session-1" }),
    );
    expect(response.status).toBe(200);
  });

  it("rejects when no scheme accepts, with the first explicit failure's reason", async () => {
    const { app } = await createTestApp({ yaml: MULTI_PLATFORM_YAML });
    const response = await app.fetch(
      chatRequest(CHAT_BODY, { "x-user-a": "alice", "x-ios": "bad" }),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("invalid attestation for ios");
  });

  it("rejects an authenticated user whose app attests nothing at all", async () => {
    // The whole point of the layer: a valid user token from a client that is not
    // the app is exactly what attestation exists to stop.
    const { app } = await createTestApp({ yaml: MULTI_PLATFORM_YAML });
    const response = await app.fetch(chatRequest(CHAT_BODY, { "x-user-a": "alice" }));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("app attestation required");
  });
});
