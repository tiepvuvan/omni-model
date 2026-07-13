import type { StorageAdapter, StorageFactory } from "@omni-model/core";
import { ConfigError } from "@omni-model/core";
import { z } from "zod";
import type { DurableObjectNamespaceLike, DurableObjectStateLike } from "./cf-types.js";

/** How each key's data lives in Durable Object storage. */
interface StoredEntry {
  value: string;
  expiresAt: number | null;
}

/**
 * The RPC wire format: one JSON body POSTed to the object. The caller passes
 * `now` (epoch ms) so the object itself needs no clock and stays fully
 * deterministic under test.
 */
const rpcBodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("get"), key: z.string(), now: z.number() }),
  z.object({
    op: z.literal("put"),
    key: z.string(),
    value: z.string(),
    ttlSeconds: z.number().optional(),
    now: z.number(),
  }),
  z.object({ op: z.literal("delete"), key: z.string(), now: z.number() }),
  z.object({
    op: z.literal("increment"),
    key: z.string(),
    amount: z.number(),
    ttlSeconds: z.number(),
    now: z.number(),
  }),
  z.object({ op: z.literal("getCounter"), key: z.string(), now: z.number() }),
]);

function badRpc(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/**
 * Durable Object hosting omni-model storage entries. Each instance answers a
 * tiny JSON RPC over `POST /` (see {@link rpcBodySchema}); the runtime's
 * per-object serial execution is what makes `increment` atomic.
 *
 * The worker entry must export this class and declare it in wrangler config
 * so the runtime can instantiate it.
 */
export class OmniStorageDurableObject {
  private readonly state: DurableObjectStateLike;

  constructor(state: DurableObjectStateLike, _env?: unknown) {
    this.state = state;
  }

  /** Expired entries are pruned on read so storage does not accumulate. */
  private async live(key: string, now: number): Promise<StoredEntry | null> {
    const entry = await this.state.storage.get<StoredEntry>(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      await this.state.storage.delete(key);
      return null;
    }
    return entry;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return badRpc("expected POST");
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return badRpc("expected a JSON body");
    }
    const parsed = rpcBodySchema.safeParse(raw);
    if (!parsed.success) return badRpc(`invalid RPC body: ${z.prettifyError(parsed.error)}`);
    const body = parsed.data;

    switch (body.op) {
      case "get": {
        const entry = await this.live(body.key, body.now);
        return Response.json({ result: entry === null ? null : entry.value });
      }
      case "put": {
        const entry: StoredEntry = {
          value: body.value,
          expiresAt: body.ttlSeconds === undefined ? null : body.now + body.ttlSeconds * 1000,
        };
        await this.state.storage.put(body.key, entry);
        return Response.json({ result: null });
      }
      case "delete": {
        await this.state.storage.delete(body.key);
        return Response.json({ result: null });
      }
      case "increment": {
        const entry = await this.live(body.key, body.now);
        // TTL applies from the first write of a window; an expired entry
        // resets to `amount` with a fresh window.
        if (entry === null) {
          const created: StoredEntry = {
            value: String(body.amount),
            expiresAt: body.now + body.ttlSeconds * 1000,
          };
          await this.state.storage.put(body.key, created);
          return Response.json({ result: body.amount });
        }
        const next = Number(entry.value) + body.amount;
        const updated: StoredEntry = { value: String(next), expiresAt: entry.expiresAt };
        await this.state.storage.put(body.key, updated);
        return Response.json({ result: next });
      }
      case "getCounter": {
        const entry = await this.live(body.key, body.now);
        return Response.json({ result: entry === null ? 0 : Number(entry.value) });
      }
    }
  }
}

const optionsSchema = z.strictObject({
  type: z.string().optional(),
  /**
   * Logical store name, prefixed onto every object name so several omni-model
   * deployments can share one Durable Object namespace without key collisions.
   */
  name: z.string().min(1).optional(),
  /** DO binding name from wrangler config; consumed by the worker entry, not by this adapter. */
  binding: z.string().min(1).optional(),
});

/**
 * Storage backed by a Durable Object namespace. Every storage key routes to
 * its own object via `idFromName(key)`, so operations on a key are serialized
 * by the runtime — counters are exact, unlike the `cloudflare-kv` adapter.
 */
export class DurableObjectStorageAdapter implements StorageAdapter {
  readonly type = "durable-object";
  private readonly namespace: DurableObjectNamespaceLike;
  private readonly name: string | undefined;
  private readonly now: () => number;

  constructor(
    namespace: DurableObjectNamespaceLike,
    options?: { name?: string; now?: () => number },
  ) {
    this.namespace = namespace;
    this.name = options?.name;
    this.now = options?.now ?? (() => Date.now());
  }

  private async call(key: string, body: Record<string, unknown>): Promise<unknown> {
    const objectName = this.name === undefined ? key : `${this.name}:${key}`;
    const stub = this.namespace.get(this.namespace.idFromName(objectName));
    const response = await stub.fetch("https://omni-storage.internal/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, key, now: this.now() }),
    });
    if (!response.ok) {
      throw new Error(
        `durable-object storage RPC failed (${response.status}): ${await response.text()}`,
      );
    }
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !("result" in payload)) {
      throw new Error("durable-object storage RPC returned a malformed response");
    }
    return (payload as { result: unknown }).result;
  }

  async get(key: string): Promise<string | null> {
    const result = await this.call(key, { op: "get" });
    if (result !== null && typeof result !== "string") {
      throw new Error('durable-object storage "get" returned a non-string result');
    }
    return result;
  }

  async put(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void> {
    await this.call(key, { op: "put", value, ttlSeconds: options?.ttlSeconds });
  }

  async delete(key: string): Promise<void> {
    await this.call(key, { op: "delete" });
  }

  async increment(key: string, amount: number, ttlSeconds: number): Promise<number> {
    const result = await this.call(key, { op: "increment", amount, ttlSeconds });
    if (typeof result !== "number") {
      throw new Error('durable-object storage "increment" returned a non-numeric result');
    }
    return result;
  }

  async getCounter(key: string): Promise<number> {
    const result = await this.call(key, { op: "getCounter" });
    if (typeof result !== "number") {
      throw new Error('durable-object storage "getCounter" returned a non-numeric result');
    }
    return result;
  }
}

/**
 * Builds the `durable-object` storage factory. The DO namespace is a Workers
 * binding that only the worker entry can see (`RuntimeContext.env` carries
 * strings only), so the entry constructs the factory from the binding and
 * registers it before config resolution.
 */
export function createDurableObjectStorageFactory(
  namespace: DurableObjectNamespaceLike,
): StorageFactory {
  return {
    type: "durable-object",
    create: (options, runtime) => {
      const parsed = optionsSchema.safeParse(options);
      if (!parsed.success) {
        throw new ConfigError(
          `invalid durable-object storage options: ${z.prettifyError(parsed.error)}`,
        );
      }
      return new DurableObjectStorageAdapter(namespace, {
        name: parsed.data.name,
        now: () => runtime.now(),
      });
    },
  };
}
