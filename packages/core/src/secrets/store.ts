import {
  openSecret,
  sealSecret,
  sealedKeyId,
  secretFingerprint,
  secretHint,
} from "./envelope.js";
import type { Keyring } from "./keyring.js";
import type { SecretDescription, SecretRow, SecretRowStore, SecretStore } from "./types.js";

function describe(row: SecretRow): SecretDescription {
  return {
    id: row.id,
    name: row.name,
    hint: row.hint,
    fingerprint: row.fingerprint,
    // Read from the sealed value itself, so it cannot claim a key that did not
    // seal it.
    keyId: sealedKeyId(row.jwe),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The one {@link SecretStore} implementation. Every backend plugs in a
 * {@link SecretRowStore} and inherits the same cryptography, so there is no way
 * for a second backend to get the envelope wrong.
 */
export class EnvelopeSecretStore implements SecretStore {
  readonly type: string;
  private readonly rows: SecretRowStore;
  private readonly keyring: Keyring;
  private readonly now: () => number;

  constructor(
    rows: SecretRowStore,
    keyring: Keyring,
    options: { type?: string; now?: () => number } = {},
  ) {
    this.rows = rows;
    this.keyring = keyring;
    this.type = options.type ?? "envelope";
    this.now = options.now ?? Date.now;
  }

  async put(name: string, value: string): Promise<SecretDescription> {
    const existing = await this.rows.findByName(name);
    // Reuse the id on replacement so every configuration referencing this
    // secret keeps working when the credential behind it is rotated.
    const id = existing?.id ?? crypto.randomUUID();
    const now = this.now();
    const row: SecretRow = {
      id,
      name,
      jwe: await sealSecret(this.keyring, id, value),
      hint: secretHint(value),
      fingerprint: await secretFingerprint(value),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.rows.upsert(row);
    return describe(row);
  }

  async reveal(id: string): Promise<string | null> {
    const row = await this.rows.findById(id);
    if (row === null) return null;
    return openSecret(this.keyring, row.id, row.jwe);
  }

  async describe(id: string): Promise<SecretDescription | null> {
    const row = await this.rows.findById(id);
    return row === null ? null : describe(row);
  }

  async describeByName(name: string): Promise<SecretDescription | null> {
    const row = await this.rows.findByName(name);
    return row === null ? null : describe(row);
  }

  async list(): Promise<SecretDescription[]> {
    return (await this.rows.list()).map(describe);
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  async rotate(): Promise<{ rotated: number; total: number }> {
    const rows = await this.rows.list();
    let rotated = 0;
    for (const row of rows) {
      if (sealedKeyId(row.jwe) === this.keyring.active.id) continue;
      // Decrypt with the old key, re-seal with the active one. The value never
      // leaves this loop, and the id is unchanged so references keep resolving.
      const plaintext = await openSecret(this.keyring, row.id, row.jwe);
      await this.rows.upsert({
        ...row,
        jwe: await sealSecret(this.keyring, row.id, plaintext),
        updatedAt: this.now(),
      });
      rotated += 1;
    }
    return { rotated, total: rows.length };
  }

  async close(): Promise<void> {
    await this.rows.close?.();
  }
}

/** In-process {@link SecretRowStore} for tests and single-instance development. */
export class MemorySecretRowStore implements SecretRowStore {
  private readonly byId = new Map<string, SecretRow>();

  async upsert(row: SecretRow): Promise<void> {
    this.byId.set(row.id, { ...row });
  }

  async findById(id: string): Promise<SecretRow | null> {
    const row = this.byId.get(id);
    return row === undefined ? null : { ...row };
  }

  async findByName(name: string): Promise<SecretRow | null> {
    for (const row of this.byId.values()) {
      if (row.name === name) return { ...row };
    }
    return null;
  }

  async list(): Promise<SecretRow[]> {
    return [...this.byId.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async delete(id: string): Promise<boolean> {
    return this.byId.delete(id);
  }
}

/** Convenience: an encrypted in-memory secret store. */
export function createMemorySecretStore(
  keyring: Keyring,
  options: { now?: () => number } = {},
): SecretStore {
  return new EnvelopeSecretStore(new MemorySecretRowStore(), keyring, {
    type: "memory",
    ...options,
  });
}
