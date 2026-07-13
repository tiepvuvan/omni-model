/**
 * Minimal structural types for the Cloudflare Workers runtime objects this
 * package touches. Deliberately not imported from `@cloudflare/workers-types`
 * (its globals conflict with the DOM lib); each interface is a structural
 * subset that the real runtime bindings satisfy, so a genuine binding can be
 * passed anywhere these types are expected.
 */

/** Structural subset of a Workers KV namespace binding (e.g. `env.OMNI_KV`). */
export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Structural subset of the Durable Object stub returned by `namespace.get(id)`. */
export interface DurableObjectStubLike {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

/** Structural subset of a Durable Object namespace binding (e.g. `env.OMNI_DO`). */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

/** Structural subset of the `DurableObjectState` handed to a Durable Object constructor. */
export interface DurableObjectStateLike {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
}
