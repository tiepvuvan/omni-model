import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/errors.js";
import {
  openSecret,
  sealedKeyId,
  sealSecret,
  secretFingerprint,
  secretHint,
} from "../../src/secrets/envelope.js";
import { createKeyring, keyringFromEnv } from "../../src/secrets/keyring.js";

/** Deterministic, distinct 32-byte keys. */
function keyMaterial(seed: number): string {
  const bytes = new Uint8Array(32).fill(seed);
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const KEY_A = keyMaterial(1);
const KEY_B = keyMaterial(2);

describe("createKeyring", () => {
  it("derives a stable id from the key, not from an ordinal", async () => {
    // Self-describing ids are what let rotation work without bookkeeping: a
    // ciphertext records which key sealed it.
    const first = await createKeyring({ active: KEY_A });
    const second = await createKeyring({ active: KEY_A, previous: [KEY_B] });

    expect(first.active.id).toBe(second.active.id);
    expect(first.active.id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("gives different keys different ids", async () => {
    const a = await createKeyring({ active: KEY_A });
    const b = await createKeyring({ active: KEY_B });
    expect(a.active.id).not.toBe(b.active.id);
  });

  it("accepts base64url and tolerates missing padding", async () => {
    const canonical = await createKeyring({ active: KEY_A });
    const urlish = KEY_A.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const parsed = await createKeyring({ active: urlish });
    expect(parsed.active.id).toBe(canonical.active.id);
  });

  it("rejects a key of the wrong length, naming the variable and the fix", async () => {
    const short = btoa(String.fromCharCode(...new Uint8Array(16).fill(7)));
    await expect(createKeyring({ active: short })).rejects.toBeInstanceOf(ConfigError);
    await expect(createKeyring({ active: short })).rejects.toThrow(/32 bytes.*openssl rand/s);
  });

  it("rejects material that is not base64", async () => {
    await expect(createKeyring({ active: "not base64!!" })).rejects.toThrow(/valid base64/);
  });

  it("keeps retired keys available and lists the active one first", async () => {
    const keyring = await createKeyring({ active: KEY_A, previous: [KEY_B] });
    const b = await createKeyring({ active: KEY_B });

    expect(keyring.keyIds()).toHaveLength(2);
    expect(keyring.keyIds()[0]).toBe(keyring.active.id);
    expect(keyring.find(b.active.id)).toBeDefined();
    expect(keyring.find("00000000")).toBeUndefined();
  });

  it("ignores a repeated or blank previous key", async () => {
    const keyring = await createKeyring({ active: KEY_A, previous: [KEY_A, "", "  "] });
    expect(keyring.keyIds()).toEqual([keyring.active.id]);
  });
});

describe("keyringFromEnv", () => {
  it("returns null when no key is set, because that is not an error", async () => {
    // A deployment that stores no secret needs no key; it becomes an error only
    // when a configuration actually references one.
    expect(await keyringFromEnv({})).toBeNull();
    expect(await keyringFromEnv({ OMNI_ENCRYPTION_KEY: "   " })).toBeNull();
  });

  it("reads the active key and a comma-separated retirement list", async () => {
    const keyring = await keyringFromEnv({
      OMNI_ENCRYPTION_KEY: KEY_A,
      OMNI_ENCRYPTION_KEY_PREVIOUS: `${KEY_B}, ${keyMaterial(3)}`,
    });
    expect(keyring?.keyIds()).toHaveLength(3);
  });
});

describe("sealSecret / openSecret", () => {
  /** The five compact-JWE segments: header, key, iv, ciphertext, tag. */
  function parts(sealed: string): string[] {
    const segments = sealed.split(".");
    expect(segments).toHaveLength(5);
    return segments;
  }

  /** Replace one segment, leaving a structurally valid but altered JWE. */
  function tamper(sealed: string, index: number): string {
    const segments = parts(sealed);
    const original = segments[index] as string;
    // Flip the first character to something else in the base64url alphabet.
    segments[index] = (original[0] === "A" ? "B" : "A") + original.slice(1);
    return segments.join(".");
  }

  it("round-trips a value", async () => {
    const keyring = await createKeyring({ active: KEY_A });
    const sealed = await sealSecret(keyring, "id-1", "sk-super-secret");

    expect(await openSecret(keyring, "id-1", sealed)).toBe("sk-super-secret");
    expect(sealedKeyId(sealed)).toBe(keyring.active.id);
  });

  it("is a standard JWE: dir + A256GCM, with the key and secret ids in the header", async () => {
    // Asserted because the format is now the storage format: a silent change to
    // `alg`/`enc` would be a silent change to what is in the database.
    const keyring = await createKeyring({ active: KEY_A });
    const sealed = await sealSecret(keyring, "id-1", "sk-secret");
    const [header, encryptedKey] = parts(sealed);

    expect(JSON.parse(new TextDecoder().decode(decodeBase64Url(header as string)))).toEqual({
      alg: "dir",
      enc: "A256GCM",
      kid: keyring.active.id,
      omni_sid: "id-1",
    });
    // `dir` derives no content key, so there is nothing to wrap.
    expect(encryptedKey).toBe("");
  });

  it("never produces the plaintext in its ciphertext or a repeated nonce", async () => {
    const keyring = await createKeyring({ active: KEY_A });
    const value = "sk-super-secret";
    const a = parts(await sealSecret(keyring, "id-1", value));
    const b = parts(await sealSecret(keyring, "id-1", value));

    expect(a[3]).not.toContain(value);
    // A reused AES-GCM nonce under one key is catastrophic, so this must differ.
    expect(a[2]).not.toBe(b[2]);
    expect(a[3]).not.toBe(b[3]);
  });

  it("handles unicode and long values", async () => {
    const keyring = await createKeyring({ active: KEY_A });
    const value = `🔐 ${"x".repeat(5000)} ünïcode`;
    const sealed = await sealSecret(keyring, "id-1", value);
    expect(await openSecret(keyring, "id-1", sealed)).toBe(value);
  });

  it("refuses a tampered ciphertext rather than returning garbage", async () => {
    const keyring = await createKeyring({ active: KEY_A });
    const sealed = await sealSecret(keyring, "id-1", "sk-secret");
    await expect(openSecret(keyring, "id-1", tamper(sealed, 3))).rejects.toThrow();
  });

  it("refuses a tampered nonce", async () => {
    const keyring = await createKeyring({ active: KEY_A });
    const sealed = await sealSecret(keyring, "id-1", "sk-secret");
    await expect(openSecret(keyring, "id-1", tamper(sealed, 2))).rejects.toThrow();
  });

  it("refuses a tampered authentication tag", async () => {
    const keyring = await createKeyring({ active: KEY_A });
    const sealed = await sealSecret(keyring, "id-1", "sk-secret");
    await expect(openSecret(keyring, "id-1", tamper(sealed, 4))).rejects.toThrow();
  });

  it("refuses a ciphertext moved to a different secret id", async () => {
    // The id is in the authenticated header, so someone with database write
    // access cannot swap one credential's value into another row: the header
    // still names the row it was sealed for, and that is checked.
    const keyring = await createKeyring({ active: KEY_A });
    const sealed = await sealSecret(keyring, "openai-key", "sk-openai");

    await expect(openSecret(keyring, "anthropic-key", sealed)).rejects.toBeInstanceOf(ConfigError);
    await expect(openSecret(keyring, "anthropic-key", sealed)).rejects.toThrow(
      /sealed for a different secret/,
    );
  });

  it("refuses a header rewritten to claim a different key", async () => {
    const a = await createKeyring({ active: KEY_A });
    const b = await createKeyring({ active: KEY_B });
    const sealed = await sealSecret(a, "id-1", "sk-secret");
    // Rewrite `kid` to a key `b` does have, so this exercises the decryption
    // failure rather than the "key not in keyring" path. The header is part of
    // the AAD, so editing it breaks the tag.
    const segments = parts(sealed);
    segments[0] = encodeBase64Url(
      new TextEncoder().encode(
        JSON.stringify({ alg: "dir", enc: "A256GCM", kid: b.active.id, omni_sid: "id-1" }),
      ),
    );
    await expect(openSecret(b, "id-1", segments.join("."))).rejects.toThrow();
  });

  it("explains how to recover when the sealing key was retired too early", async () => {
    const old = await createKeyring({ active: KEY_B });
    const sealed = await sealSecret(old, "id-1", "sk-secret");
    const current = await createKeyring({ active: KEY_A });

    await expect(openSecret(current, "id-1", sealed)).rejects.toBeInstanceOf(ConfigError);
    await expect(openSecret(current, "id-1", sealed)).rejects.toThrow(
      /OMNI_ENCRYPTION_KEY_PREVIOUS/,
    );
  });

  it("reads a secret sealed by a retired key still on the keyring", async () => {
    const old = await createKeyring({ active: KEY_B });
    const sealed = await sealSecret(old, "id-1", "sk-secret");
    const rotated = await createKeyring({ active: KEY_A, previous: [KEY_B] });

    expect(await openSecret(rotated, "id-1", sealed)).toBe("sk-secret");
  });
});

describe("secretHint / secretFingerprint", () => {
  it("shows only the tail, and nothing for a short value", () => {
    expect(secretHint("sk-abcdefghijkl")).toBe("…ijkl");
    expect(secretHint("short")).toBe("");
    expect(secretHint("")).toBe("");
  });

  it("fingerprints equal values equally and different values differently", async () => {
    expect(await secretFingerprint("a-value")).toBe(await secretFingerprint("a-value"));
    expect(await secretFingerprint("a-value")).not.toBe(await secretFingerprint("b-value"));
    expect(await secretFingerprint("a-value")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("never embeds the value it describes", async () => {
    const value = "sk-abcdefghijkl";
    expect(await secretFingerprint(value)).not.toContain("abcdef");
    expect(secretHint(value)).not.toContain("abcdef");
  });
});
