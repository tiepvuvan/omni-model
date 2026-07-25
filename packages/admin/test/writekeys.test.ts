import {
  hashWriteKeySecret,
  WRITE_KEY_PREFIX,
  type WriteKey,
  writeKeyState,
} from "@omni-model/core";
import { describe, expect, it } from "vitest";
import { baseConfig, createTestAdmin, errorOf, FIXED_NOW } from "./helpers.js";

interface CreatedKey {
  writeKey: {
    id: string;
    name: string;
    prefix: string;
    last4: string;
    allowedModels: string[] | null;
    captureContent: boolean | null;
    createdBy: string | null;
    expiresAt: number | null;
    disabledAt: number | null;
  };
  secret: string;
}

async function mint(
  call: Awaited<ReturnType<typeof createTestAdmin>>["call"],
  body: Record<string, unknown> = { name: "ios app" },
): Promise<CreatedKey> {
  const response = await call("/admin/api/write-keys", {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as CreatedKey;
}

describe("write keys", () => {
  it("returns the plaintext exactly once, and never again", async () => {
    const { call, writeKeys } = await createTestAdmin({ config: baseConfig() });
    const created = await mint(call);
    expect(created.secret.startsWith(WRITE_KEY_PREFIX)).toBe(true);
    expect(created.writeKey.createdBy).toBe("root@test");

    // The store holds only the hash, and the list endpoint returns descriptions.
    const listed = (await (await call("/admin/api/write-keys")).json()) as {
      writeKeys: Array<Record<string, unknown>>;
    };
    expect(listed.writeKeys).toHaveLength(1);
    const serialized = JSON.stringify(listed.writeKeys);
    expect(serialized).not.toContain(created.secret);
    // Nor the hash: a leaked hash is offline-guessable against a known format.
    expect(serialized).not.toContain(await hashWriteKeySecret(created.secret));

    // And the plaintext still authenticates, so what was returned is real.
    expect(await writeKeys.authenticate(created.secret)).not.toBeNull();
  });

  it("carries an allowlist and a content-capture override", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const created = await mint(call, {
      name: "restricted",
      allowedModels: ["gpt-4o-mini"],
      captureContent: false,
      metadata: { platform: "ios" },
      expiresAt: Date.UTC(2027, 0, 1),
    });
    expect(created.writeKey.allowedModels).toEqual(["gpt-4o-mini"]);
    expect(created.writeKey.captureContent).toBe(false);
    expect(created.writeKey.expiresAt).toBe(Date.UTC(2027, 0, 1));
  });

  it("revokes a key, and says so when it was already revoked", async () => {
    const { call, writeKeys } = await createTestAdmin({ config: baseConfig() });
    const created = await mint(call);

    const first = await call(`/admin/api/write-keys/${created.writeKey.id}`, { method: "DELETE" });
    expect(await first.json()).toEqual({ revoked: true });
    // The row is kept, so logs stay attributable; what changes is its state.
    const authenticated = await writeKeys.authenticate(created.secret);
    expect(authenticated).not.toBeNull();
    expect(writeKeyState(authenticated as WriteKey, FIXED_NOW)).toBe("revoked");

    const second = await call(`/admin/api/write-keys/${created.writeKey.id}`, { method: "DELETE" });
    expect(await second.json()).toEqual({ revoked: false, alreadyRevoked: true });
  });

  it("404s for a key that never existed", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/write-keys/does-not-exist", { method: "DELETE" });
    expect(response.status).toBe(404);
  });

  it("rejects an unnamed key", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/write-keys", {
      method: "POST",
      body: JSON.stringify({ allowedModels: ["gpt-4o"] }),
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("invalid_body");
  });

  it("reports usage for a key that has not been used yet", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const created = await mint(call);
    const response = await call(`/admin/api/write-keys/${created.writeKey.id}/usage`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      windowHours: 24,
      requests: 0,
      failed: 0,
      totalTokens: 0,
      recent: [],
    });
  });

  it("404s on usage for a key that does not exist, before touching the database", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    expect((await call("/admin/api/write-keys/ghost/usage")).status).toBe(404);
  });

  it("rejects a nonsensical usage window", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const created = await mint(call);
    const response = await call(`/admin/api/write-keys/${created.writeKey.id}/usage?hours=-3`);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/positive/);
  });
});
