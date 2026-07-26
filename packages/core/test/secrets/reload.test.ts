import { describe, expect, it } from "vitest";
import { createKeyring } from "../../src/secrets/keyring.js";
import { createMemorySecretStore } from "../../src/secrets/store.js";
import type { SecretStore } from "../../src/secrets/types.js";
import { createRecordingLogger, createTestProxy } from "../server/helpers.js";

const CANARY = "sk-plaintext-canary-value";

function keyMaterial(seed: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(seed)));
}

async function secretStore(value = CANARY): Promise<{ store: SecretStore; id: string }> {
  const store = createMemorySecretStore(await createKeyring({ active: keyMaterial(1) }));
  const { id } = await store.put("upstream", value);
  return { store, id };
}

/** A configuration whose provider key is a secret reference. */
function configWithSecret(secretId: string): Record<string, unknown> {
  return {
    version: 1,
    storage: { type: "memory" },
    security: { providers: [{ type: "test-authenticated" }] },
    routing: {
      rules: [
        { id: "main", when: "true", target: { type: "fake", apiKey: { $secret: secretId } } },
      ],
    },
    rateLimits: [],
  };
}

describe("secrets in a reload", () => {
  it("builds a bundle from a document that only holds references", async () => {
    const { store, id } = await secretStore();
    const proxy = await createTestProxy({ initOverrides: { secrets: store } });

    const result = await proxy.reloadRaw(configWithSecret(id));

    expect(result.ok).toBe(true);
    // The live bundle has the plaintext; the document we handed in never did.
    expect(proxy.holder.current()?.config.routing.rules[0]?.target).toMatchObject({
      apiKey: CANARY,
    });
    expect(JSON.stringify(configWithSecret(id))).not.toContain(CANARY);
  });

  it("rejects a reference to a deleted secret and keeps serving", async () => {
    const { store, id } = await secretStore();
    const proxy = await createTestProxy({ initOverrides: { secrets: store } });
    await proxy.reloadRaw(configWithSecret(id));
    const before = proxy.holder.current();

    await store.delete(id);
    const result = await proxy.reloadRaw(configWithSecret(id));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("unresolved_secret");
      expect(result.error).toContain("$.routing.rules[0].target.apiKey");
    }
    // Identity unchanged: the previous configuration is still the live one.
    expect(proxy.holder.current()).toBe(before);
    expect(proxy.holder.status().configured).toBe(true);
  });

  it("rejects a document with references when no secret store is wired", async () => {
    const { id } = await secretStore();
    const proxy = await createTestProxy();

    const result = await proxy.reloadRaw(configWithSecret(id));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/OMNI_ENCRYPTION_KEY/);
  });

  it("picks up a rotated credential on the next reload, same reference", async () => {
    // This is the operational payoff: replacing a leaked key is a secret write
    // plus a reload, with no configuration edit at all.
    const { store, id } = await secretStore();
    const proxy = await createTestProxy({ initOverrides: { secrets: store } });
    await proxy.reloadRaw(configWithSecret(id));
    expect(proxy.holder.current()?.config.routing.rules[0]?.target).toMatchObject({
      apiKey: CANARY,
    });

    await store.put("upstream", "sk-rotated-value");
    await proxy.reloadRaw(configWithSecret(id));

    expect(proxy.holder.current()?.config.routing.rules[0]?.target).toMatchObject({
      apiKey: "sk-rotated-value",
    });
  });

  it("keeps secret plaintext out of logs on every failure path", async () => {
    // Errors and log fields are the realistic leak routes: they reach stdout and,
    // through the admin API, HTTP responses.
    const { store, id } = await secretStore();
    const { logger, entries } = createRecordingLogger();
    const proxy = await createTestProxy({ initOverrides: { secrets: store }, logger });

    await proxy.reloadRaw(configWithSecret(id));
    // A valid secret, but a configuration that fails to build for another reason.
    await proxy.reloadRaw({ ...configWithSecret(id), security: { providers: [] } });
    // A configuration whose provider type does not exist.
    await proxy.reloadRaw({
      ...configWithSecret(id),
      routing: {
        rules: [{ id: "main", when: "true", target: { type: "nope", apiKey: { $secret: id } } }],
      },
    });
    await store.delete(id);
    await proxy.reloadRaw(configWithSecret(id));

    const logged = JSON.stringify(entries);
    expect(logged).not.toContain(CANARY);
    expect(logged).not.toContain("canary");
    expect(proxy.holder.status().lastError).not.toContain(CANARY);
    // Sanity: those reloads really did fail, so the assertion above means something.
    expect(entries.some((entry) => entry.message.includes("rejected"))).toBe(true);
  });
});
