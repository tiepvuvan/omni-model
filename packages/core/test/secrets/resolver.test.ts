import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/errors.js";
import { createKeyring } from "../../src/secrets/keyring.js";
import { resolveSecretRefs } from "../../src/secrets/resolver.js";
import { createMemorySecretStore } from "../../src/secrets/store.js";
import type { SecretStore } from "../../src/secrets/types.js";

const CANARY = "sk-plaintext-canary-value";

async function storeWith(
  name = "openai",
  value = CANARY,
): Promise<{
  store: SecretStore;
  id: string;
}> {
  const store = createMemorySecretStore(
    await createKeyring({ active: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))) }),
  );
  const { id } = await store.put(name, value);
  return { store, id };
}

describe("resolveSecretRefs", () => {
  it("leaves a document without references untouched", async () => {
    const { store } = await storeWith();
    const document = { providers: { openai: { apiKey: "literal" } } };
    // Same object identity: no needless rebuild when there is nothing to do.
    expect(await resolveSecretRefs(document, store)).toBe(document);
  });

  it("substitutes references anywhere in the document", async () => {
    const { store, id } = await storeWith();
    const resolved = await resolveSecretRefs(
      {
        providers: { openai: { apiKey: { $secret: id } } },
        security: { providers: [{ type: "jwt", secret: { $secret: id } }] },
        nested: [[{ deep: { $secret: id } }]],
      },
      store,
    );

    expect(resolved).toEqual({
      providers: { openai: { apiKey: CANARY } },
      security: { providers: [{ type: "jwt", secret: CANARY }] },
      nested: [[{ deep: CANARY }]],
    });
  });

  it("does not mutate the document it was given", async () => {
    // The caller's copy is the *stored* revision; mutating it would write
    // plaintext back into the config store.
    const { store, id } = await storeWith();
    const document = { providers: { openai: { apiKey: { $secret: id } } } };
    await resolveSecretRefs(document, store);

    expect(document.providers.openai.apiKey).toEqual({ $secret: id });
    expect(JSON.stringify(document)).not.toContain(CANARY);
  });

  it("names the path of an unknown reference, without a value", async () => {
    const { store } = await storeWith();
    const missing = "11111111-1111-1111-1111-111111111111";

    const error = await resolveSecretRefs(
      { providers: { openai: { apiKey: { $secret: missing } } } },
      store,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("$.providers.openai.apiKey");
    expect((error as ConfigError).message).toContain(missing);
  });

  it("explains what to set when there is no secret store at all", async () => {
    const error = await resolveSecretRefs({ a: { $secret: "some-id" } }, null).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toMatch(/OMNI_ENCRYPTION_KEY/);
    expect((error as ConfigError).message).toContain("$.a");
  });

  it("rejects a malformed reference instead of passing it through as an object", async () => {
    const { store } = await storeWith();
    // Passing `{ $secret: 42 }` through would hand a provider an object where it
    // expected a key, failing much later and much less clearly.
    await expect(resolveSecretRefs({ a: { $secret: 42 } }, store)).rejects.toThrow(
      /must be a string id/,
    );
    await expect(resolveSecretRefs({ a: { $secret: "" } }, store)).rejects.toThrow(/empty id/);
    await expect(resolveSecretRefs({ a: { $secret: "id", extra: true } }, store)).rejects.toThrow(
      /only "\$secret"/,
    );
  });

  it("reads each distinct secret once, however often it is referenced", async () => {
    const { store, id } = await storeWith();
    let reveals = 0;
    const counting: SecretStore = {
      ...store,
      reveal: async (secretId) => {
        reveals += 1;
        return store.reveal(secretId);
      },
    };

    await resolveSecretRefs(
      { a: { $secret: id }, b: { $secret: id }, c: { $secret: id } },
      counting,
    );

    expect(reveals).toBe(1);
  });

  it("surfaces a decryption failure with the path and the recovery hint", async () => {
    const { store, id } = await storeWith();
    const broken: SecretStore = {
      ...store,
      reveal: async () => {
        throw new ConfigError(
          'was encrypted with key "deadbeef"; add it to OMNI_ENCRYPTION_KEY_PREVIOUS',
        );
      },
    };

    const error = await resolveSecretRefs({ providers: { x: { $secret: id } } }, broken).catch(
      (cause: unknown) => cause,
    );

    expect((error as ConfigError).message).toContain("$.providers.x");
    expect((error as ConfigError).message).toMatch(/OMNI_ENCRYPTION_KEY_PREVIOUS/);
  });

  it("never puts a secret value in an error message", async () => {
    // Errors reach logs and, via the admin API, HTTP responses.
    const { store, id } = await storeWith();
    const cases: unknown[] = [
      { a: { $secret: "unknown-id" } },
      { a: { $secret: 42 } },
      { a: { $secret: "" } },
      { a: { $secret: id, extra: 1 } },
    ];

    for (const document of cases) {
      const error = await resolveSecretRefs(document, store).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain(CANARY);
      expect((error as ConfigError).message).not.toContain("canary");
    }
  });
});
