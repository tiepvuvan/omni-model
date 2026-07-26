import { describe, expect, it } from "vitest";
import { WRITE_KEY_HEADER } from "../../src/server/writekey.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import { MemoryWriteKeyStore } from "../../src/writekeys/memory.js";
import { CHAT_BODY, chatRequest, createTestProxy, FIXED_NOW } from "../server/helpers.js";

/**
 * Fixtures are assembled from named blocks rather than string-appended, because
 * appending to a YAML document silently produces a different document.
 */
function fixture(
  parts: {
    security?: string;
    /** Rules inserted *before* the catch-all, which is where a specific rule goes. */
    routing?: string;
    allowedModels?: string;
    rateLimits?: string;
  } = {},
): string {
  return [
    "version: 1",
    "storage: { type: memory }",
    `routing:${parts.allowedModels === undefined ? "" : `\n  allowedModels: ${parts.allowedModels}`}` +
      `\n  rules:${parts.routing ?? ""}` +
      '\n    - { id: main, when: "true", target: { type: fake } }',
    parts.rateLimits ?? "rateLimits: []",
    parts.security === undefined ? "" : `security:${parts.security}`,
  ]
    .filter((part) => part !== "")
    .join("\n");
}

const BASE = fixture();
const REQUIRED = fixture({ security: "\n  requireWriteKey: true" });

async function setup(yaml = BASE, options: { storage?: MemoryStorageAdapter } = {}) {
  const writeKeys = new MemoryWriteKeyStore(() => FIXED_NOW);
  const proxy = await createTestProxy({
    yaml,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    initOverrides: { writeKeys },
  });
  return { ...proxy, writeKeys };
}

/** Body of an error response. */
async function errorOf(response: Response): Promise<{ message: string; code: string | null }> {
  const body = (await response.json()) as { error: { message: string; code: string | null } };
  return body.error;
}

describe("write key middleware", () => {
  it("uses x-omni-key so a client can send a user token at the same time", async () => {
    // Authorization belongs to the jwt/firebase/supabase verifiers. Sharing it
    // would make "which app" and "which user" mutually exclusive.
    const { app, writeKeys } = await setup(REQUIRED);
    const { secret } = await writeKeys.create({ name: "ios-app" });

    const viaAuthorization = await app.fetch(
      chatRequest(CHAT_BODY, { authorization: `Bearer ${secret}` }),
    );
    expect(viaAuthorization.status).toBe(401);

    const viaOwnHeader = await app.fetch(chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: secret }));
    expect(viaOwnHeader.status).toBe(200);
  });

  it("when not required, allows a request with no key at all", async () => {
    // The default, so upgrading does not lock out existing clients.
    const { app } = await setup();
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);
  });

  it("validates a presented key even when keys are not required", async () => {
    // Otherwise a revoked client keeps working by dropping the header, and every
    // log line is attributed to nobody.
    const { app, writeKeys } = await setup();
    const { writeKey, secret } = await writeKeys.create({ name: "ios-app" });
    await writeKeys.revoke(writeKey.id);

    const response = await app.fetch(chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: secret }));
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("write_key_revoked");
  });

  it("distinguishes missing, invalid, revoked and expired", async () => {
    const { app, writeKeys } = await setup(REQUIRED);

    const missing = await app.fetch(chatRequest(CHAT_BODY));
    expect(missing.status).toBe(401);
    const missingError = await errorOf(missing);
    expect(missingError.code).toBe("write_key_required");
    // The error has to say which header to send, or it is not actionable.
    expect(missingError.message).toContain(WRITE_KEY_HEADER);

    const invalid = await app.fetch(chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: "omk_nonsense" }));
    expect((await errorOf(invalid)).code).toBe("write_key_invalid");

    const revokedKey = await writeKeys.create({ name: "revoked" });
    await writeKeys.revoke(revokedKey.writeKey.id);
    const revoked = await app.fetch(
      chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: revokedKey.secret }),
    );
    expect((await errorOf(revoked)).code).toBe("write_key_revoked");

    const expiredKey = await writeKeys.create({ name: "expired", expiresAt: FIXED_NOW - 1 });
    const expired = await app.fetch(
      chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: expiredKey.secret }),
    );
    expect((await errorOf(expired)).code).toBe("write_key_expired");
  });

  it("never echoes the presented key back", async () => {
    const { app, writeKeys } = await setup(REQUIRED);
    const { writeKey, secret } = await writeKeys.create({ name: "ios-app" });
    await writeKeys.revoke(writeKey.id);

    const response = await app.fetch(chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: secret }));
    expect(await response.text()).not.toContain(secret);
  });

  it("refuses when keys are required but no store is wired", async () => {
    // Failing closed: "required" that silently does nothing is worse than an error.
    const proxy = await createTestProxy({ yaml: REQUIRED });
    const response = await proxy.app.fetch(
      chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: "omk_anything-at-all-here" }),
    );
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("write_key_unavailable");
  });

  it("becomes required, and stops being required, on a reload", async () => {
    const { app, reload } = await setup(BASE);
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);

    await reload(REQUIRED);
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(401);

    await reload(BASE);
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);
  });

  it("lets a public path through without a key", async () => {
    const { app } = await setup(
      fixture({ security: '\n  requireWriteKey: true\n  publicPaths: ["/v1/models"]' }),
    );
    expect((await app.fetch(new Request("http://local/v1/models"))).status).toBe(200);
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(401);
  });
});

describe("write key attribution", () => {
  it("routes by client name, which only works if client reached CEL", async () => {
    const { app, providers, writeKeys } = await setup(
      fixture({
        routing:
          "\n    - { id: by-client, when: 'client.name == \"ios-app\"', " +
          "target: { type: fake, model: routed-for-ios } }",
      }),
    );
    const { secret } = await writeKeys.create({ name: "ios-app" });
    const other = await writeKeys.create({ name: "android-app" });

    // Each rule owns its upstream now, so *which* provider was called is itself
    // the assertion that the right rule matched.
    await app.fetch(chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: secret }));
    expect(providers.get("by-client")?.chatCalls.at(-1)?.request.model).toBe("routed-for-ios");
    expect(providers.get("main")?.chatCalls).toHaveLength(0);

    await app.fetch(chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: other.secret }));
    expect(providers.get("main")?.chatCalls.at(-1)?.request.model).toBe("smart");
    expect(providers.get("by-client")?.chatCalls).toHaveLength(1);
  });

  it("routes on whether a client is known, and falls through without a key", async () => {
    const { app, providers, writeKeys } = await setup(
      fixture({
        routing:
          "\n    - { id: known-clients, when: 'client.authenticated', " +
          "target: { type: fake, model: for-known-clients } }",
      }),
    );
    const { secret } = await writeKeys.create({ name: "ios-app" });

    await app.fetch(chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: secret }));
    expect(providers.get("known-clients")?.chatCalls.at(-1)?.request.model).toBe(
      "for-known-clients",
    );

    await app.fetch(chatRequest(CHAT_BODY));
    // No key: that rule does not apply and the catch-all keeps the alias.
    expect(providers.get("main")?.chatCalls.at(-1)?.request.model).toBe("smart");
  });

  it("keys a rate limit per client", async () => {
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app, writeKeys } = await setup(
      fixture({
        rateLimits:
          "rateLimits:\n  - id: per-client\n    name: per-client\n    key: client\n" +
          "    requests: { limit: 2, window: 1h }",
      }),
      { storage },
    );
    const first = await writeKeys.create({ name: "app-one" });
    const second = await writeKeys.create({ name: "app-two" });

    const call = (secret: string) =>
      app.fetch(chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: secret }));

    expect((await call(first.secret)).status).toBe(200);
    expect((await call(first.secret)).status).toBe(200);
    expect((await call(first.secret)).status).toBe(429);
    // A different application has its own budget.
    expect((await call(second.secret)).status).toBe(200);
  });
});

describe("per-key model allowlist", () => {
  it("404s a model the key may not use, and serves one it may", async () => {
    const { app, writeKeys } = await setup(REQUIRED);
    const { secret } = await writeKeys.create({ name: "cheap-only", allowedModels: ["cheap"] });

    const allowed = await app.fetch(
      chatRequest({ ...CHAT_BODY, model: "cheap" }, { [WRITE_KEY_HEADER]: secret }),
    );
    expect(allowed.status).toBe(200);

    const blocked = await app.fetch(
      chatRequest({ ...CHAT_BODY, model: "expensive" }, { [WRITE_KEY_HEADER]: secret }),
    );
    expect(blocked.status).toBe(404);
    // Reported as absent, not forbidden: probing must not reveal what exists.
    expect((await errorOf(blocked)).code).toBe("model_not_found");
  });

  it("hides disallowed models from /v1/models rather than advertising a 404", async () => {
    const { app, writeKeys } = await setup(
      fixture({
        security: "\n  requireWriteKey: true",
        allowedModels: "[cheap, expensive]",
      }),
    );
    const { secret } = await writeKeys.create({ name: "cheap-only", allowedModels: ["cheap"] });

    const listed = await app.fetch(
      new Request("http://local/v1/models", { headers: { [WRITE_KEY_HEADER]: secret } }),
    );
    const body = (await listed.json()) as { data: { id: string }[] };
    expect(body.data.map((model) => model.id)).toEqual(["cheap"]);
  });

  it("applies to embeddings too", async () => {
    const { app, writeKeys } = await setup(REQUIRED);
    const { secret } = await writeKeys.create({ name: "cheap-only", allowedModels: ["cheap"] });

    const response = await app.fetch(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", [WRITE_KEY_HEADER]: secret },
        body: JSON.stringify({ model: "expensive", input: "hi" }),
      }),
    );
    expect(response.status).toBe(404);
  });

  it("an unrestricted key reaches everything", async () => {
    const { app, writeKeys } = await setup(REQUIRED);
    const { secret } = await writeKeys.create({ name: "full-access" });

    const response = await app.fetch(
      chatRequest({ ...CHAT_BODY, model: "anything" }, { [WRITE_KEY_HEADER]: secret }),
    );
    expect(response.status).toBe(200);
  });
});
