import type { ConfigStore, SaveConfigOptions, StoredConfig, StoredConfigMeta } from "./types.js";

interface Revision extends StoredConfig {
  active: boolean;
}

/**
 * In-process {@link ConfigStore}. Used by tests and by single-instance
 * development runs that do not want a database.
 *
 * Nothing is shared and nothing survives a restart, so `watch` notifies only
 * listeners in this process — which is exactly the limitation that makes
 * Postgres the production choice.
 */
export class MemoryConfigStore implements ConfigStore {
  readonly type = "memory";
  private readonly revisions: Revision[] = [];
  private readonly listeners = new Set<(revision: number) => void>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async loadActive(): Promise<StoredConfig | null> {
    const active = this.revisions.find((revision) => revision.active);
    return active === undefined ? null : strip(active);
  }

  async save(document: unknown, options: SaveConfigOptions = {}): Promise<StoredConfig> {
    for (const revision of this.revisions) revision.active = false;
    const revision: Revision = {
      revision: this.revisions.length + 1,
      // Detach from the caller's object so a later mutation cannot rewrite
      // history, matching what a real database gives you.
      document: structuredClone(document),
      createdAt: this.now(),
      createdBy: options.createdBy ?? null,
      note: options.note ?? null,
      active: true,
    };
    this.revisions.push(revision);
    for (const listener of this.listeners) listener(revision.revision);
    return strip(revision);
  }

  async get(revision: number): Promise<StoredConfig | null> {
    const found = this.revisions.find((entry) => entry.revision === revision);
    return found === undefined ? null : strip(found);
  }

  async history(limit = 50): Promise<StoredConfigMeta[]> {
    return this.revisions
      .slice()
      .reverse()
      .slice(0, limit)
      .map((entry) => ({
        revision: entry.revision,
        createdAt: entry.createdAt,
        createdBy: entry.createdBy,
        note: entry.note,
        active: entry.active,
      }));
  }

  watch(onChange: (revision: number) => void): () => void {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }
}

function strip(revision: Revision): StoredConfig {
  const { active: _active, ...rest } = revision;
  return { ...rest, document: structuredClone(rest.document) };
}
