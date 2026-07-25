import { describe, expect, it } from "vitest";
import { sealedKeyId } from "../../src/secrets/envelope.js";
import { createKeyring, type Keyring } from "../../src/secrets/keyring.js";
import {
  createMemorySecretStore,
  EnvelopeSecretStore,
  MemorySecretRowStore,
} from "../../src/secrets/store.js";

function keyMaterial(seed: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(seed)));
}

async function keyring(seed = 1, previous: number[] = []): Promise<Keyring> {
  return createKeyring({
    active: keyMaterial(seed),
    previous: previous.map((value) => keyMaterial(value)),
  });
}

describe("EnvelopeSecretStore", () => {
  it("stores a value and describes it without revealing it", async () => {
    const store = createMemorySecretStore(await keyring());
    const description = await store.put("openai", "sk-abcdefghijkl");

    expect(description.name).toBe("openai");
    expect(description.hint).toBe("…ijkl");
    expect(description.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(description.id).toMatch(/^[0-9a-f-]{36}$/);
    // The whole point: a description is safe to send to a dashboard.
    expect(JSON.stringify(description)).not.toContain("sk-abcdefghijkl");
    expect(JSON.stringify(description)).not.toContain("abcdefgh");
  });

  it("reveals the plaintext only through reveal()", async () => {
    const store = createMemorySecretStore(await keyring());
    const { id } = await store.put("openai", "sk-value");

    expect(await store.reveal(id)).toBe("sk-value");
    expect(await store.reveal("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("keeps the id when a credential is rotated, so references keep working", async () => {
    // Replacing a leaked API key must not require editing every configuration
    // that points at it.
    const store = createMemorySecretStore(await keyring());
    const first = await store.put("openai", "sk-old-value");
    const second = await store.put("openai", "sk-new-value");

    expect(second.id).toBe(first.id);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.createdAt).toBe(first.createdAt);
    expect(await store.reveal(first.id)).toBe("sk-new-value");
    expect(await store.list()).toHaveLength(1);
  });

  it("never persists plaintext", async () => {
    // Inspect the rows directly: whatever a database backup contains, it must
    // not contain the credential.
    const rows = new MemorySecretRowStore();
    const store = new EnvelopeSecretStore(rows, await keyring());
    await store.put("openai", "sk-plaintext-canary");

    const stored = await rows.list();
    expect(stored).toHaveLength(1);
    const serialized = JSON.stringify(stored, (_key, value) =>
      value instanceof Uint8Array ? [...value] : value,
    );
    expect(serialized).not.toContain("sk-plaintext-canary");
    expect(new TextDecoder().decode(stored[0]?.ciphertext)).not.toContain("canary");
  });

  it("describes, lists and deletes", async () => {
    const store = createMemorySecretStore(await keyring());
    const a = await store.put("anthropic", "sk-ant-value");
    await store.put("openai", "sk-oai-value");

    expect((await store.describe(a.id))?.name).toBe("anthropic");
    expect((await store.describeByName("openai"))?.hint).toBe("…alue");
    expect((await store.list()).map((entry) => entry.name)).toEqual(["anthropic", "openai"]);

    expect(await store.delete(a.id)).toBe(true);
    expect(await store.delete(a.id)).toBe(false);
    expect(await store.describe(a.id)).toBeNull();
  });

  it("rotates every secret to the active key, and is idempotent", async () => {
    const rows = new MemorySecretRowStore();
    const oldKeyring = await keyring(2);
    await new EnvelopeSecretStore(rows, oldKeyring).put("openai", "sk-value");
    const sealedUnderOld = (await rows.list())[0];

    // The operator adds a new active key and keeps the old one for reading.
    const rotatedKeyring = await keyring(1, [2]);
    const store = new EnvelopeSecretStore(rows, rotatedKeyring);

    expect(await store.rotate()).toEqual({ rotated: 1, total: 1 });
    const sealedUnderNew = (await rows.list())[0];
    // Which key sealed a value is read from the sealed value itself, so there is
    // no column that could claim a rotation that did not happen.
    expect(sealedKeyId(sealedUnderNew?.jwe ?? "")).toBe(rotatedKeyring.active.id);
    expect(sealedKeyId(sealedUnderNew?.jwe ?? "")).not.toBe(
      sealedKeyId(sealedUnderOld?.jwe ?? ""),
    );
    // Same id, same value, new key: references and behaviour are unchanged.
    expect(sealedUnderNew?.id).toBe(sealedUnderOld?.id);
    expect(await store.reveal(sealedUnderNew?.id ?? "")).toBe("sk-value");

    expect(await store.rotate()).toEqual({ rotated: 0, total: 1 });
  });

  it("reads a secret sealed under a retired key without rotating", async () => {
    // Rotation is optional: retiring a key lazily must not break reads.
    const rows = new MemorySecretRowStore();
    const { id } = await new EnvelopeSecretStore(rows, await keyring(2)).put("openai", "sk-value");
    const store = new EnvelopeSecretStore(rows, await keyring(1, [2]));

    expect(await store.reveal(id)).toBe("sk-value");
  });
});
