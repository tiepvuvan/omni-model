import { generateWriteKeySecret, hashWriteKeySecret, writeKeyLabel } from "./keys.js";
import type { CreatedWriteKey, CreateWriteKeyInput, WriteKey, WriteKeyStore } from "./types.js";

interface Entry {
  key: WriteKey;
  hash: string;
}

/**
 * In-process {@link WriteKeyStore} for tests and single-instance development.
 *
 * Nothing is shared or persisted, so a key minted here vanishes on restart —
 * which is exactly why production uses Postgres.
 */
export class MemoryWriteKeyStore implements WriteKeyStore {
  readonly type = "memory";
  private readonly byId = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async create(input: CreateWriteKeyInput): Promise<CreatedWriteKey> {
    const secret = generateWriteKeySecret();
    const label = writeKeyLabel(secret);
    const writeKey: WriteKey = {
      id: crypto.randomUUID(),
      name: input.name,
      prefix: label.prefix,
      last4: label.last4,
      allowedModels: input.allowedModels ?? null,
      captureContent: input.captureContent ?? null,
      metadata: input.metadata ?? {},
      createdBy: input.createdBy ?? null,
      createdAt: this.now(),
      expiresAt: input.expiresAt ?? null,
      disabledAt: null,
    };
    this.byId.set(writeKey.id, { key: writeKey, hash: await hashWriteKeySecret(secret) });
    return { writeKey, secret };
  }

  async authenticate(secret: string): Promise<WriteKey | null> {
    const hash = await hashWriteKeySecret(secret);
    for (const entry of this.byId.values()) {
      if (entry.hash === hash) return { ...entry.key };
    }
    return null;
  }

  async get(id: string): Promise<WriteKey | null> {
    const entry = this.byId.get(id);
    return entry === undefined ? null : { ...entry.key };
  }

  async list(): Promise<WriteKey[]> {
    return [...this.byId.values()]
      .map((entry) => ({ ...entry.key }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async revoke(id: string): Promise<boolean> {
    const entry = this.byId.get(id);
    if (entry === undefined || entry.key.disabledAt !== null) return false;
    entry.key = { ...entry.key, disabledAt: this.now() };
    return true;
  }
}
