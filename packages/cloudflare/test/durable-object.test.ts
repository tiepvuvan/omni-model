import type { RuntimeContext } from "@omni-model/core";
import { ConfigError, silentLogger } from "@omni-model/core";
import { describe, expect, it } from "vitest";
import type {
  DurableObjectNamespaceLike,
  DurableObjectStateLike,
  DurableObjectStubLike,
} from "../src/cf-types.js";
import {
  createDurableObjectStorageFactory,
  DurableObjectStorageAdapter,
  OmniStorageDurableObject,
} from "../src/durable-object.js";

const T0 = 1_700_000_000_000;

function fakeState(): DurableObjectStateLike {
  const entries = new Map<string, unknown>();
  return {
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return entries.get(key) as T | undefined;
      },
      async put(key: string, value: unknown): Promise<void> {
        entries.set(key, value);
      },
      async delete(key: string): Promise<boolean> {
        return entries.delete(key);
      },
    },
  };
}

function rpc(body: unknown): Request {
  return new Request("https://do.internal/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function result(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { result: unknown };
  return payload.result;
}

describe("OmniStorageDurableObject", () => {
  it("round-trips put/get/delete", async () => {
    const object = new OmniStorageDurableObject(fakeState());
    expect(await result(await object.fetch(rpc({ op: "get", key: "k", now: T0 })))).toBeNull();
    await object.fetch(rpc({ op: "put", key: "k", value: "v1", now: T0 }));
    expect(await result(await object.fetch(rpc({ op: "get", key: "k", now: T0 })))).toBe("v1");
    await object.fetch(rpc({ op: "delete", key: "k", now: T0 }));
    expect(await result(await object.fetch(rpc({ op: "get", key: "k", now: T0 })))).toBeNull();
  });

  it("keeps values without a TTL alive indefinitely", async () => {
    const object = new OmniStorageDurableObject(fakeState());
    await object.fetch(rpc({ op: "put", key: "k", value: "v", now: T0 }));
    const farFuture = T0 + 365 * 24 * 3600 * 1000;
    expect(await result(await object.fetch(rpc({ op: "get", key: "k", now: farFuture })))).toBe(
      "v",
    );
  });

  it("expires values by the caller-provided clock", async () => {
    const object = new OmniStorageDurableObject(fakeState());
    await object.fetch(rpc({ op: "put", key: "k", value: "v", ttlSeconds: 60, now: T0 }));
    expect(await result(await object.fetch(rpc({ op: "get", key: "k", now: T0 + 59_000 })))).toBe(
      "v",
    );
    expect(
      await result(await object.fetch(rpc({ op: "get", key: "k", now: T0 + 60_000 }))),
    ).toBeNull();
  });

  it("increments from first write, keeping the original window expiry", async () => {
    const object = new OmniStorageDurableObject(fakeState());
    const first = await object.fetch(
      rpc({ op: "increment", key: "c", amount: 5, ttlSeconds: 60, now: T0 }),
    );
    expect(await result(first)).toBe(5);
    const second = await object.fetch(
      rpc({ op: "increment", key: "c", amount: 3, ttlSeconds: 60, now: T0 + 30_000 }),
    );
    expect(await result(second)).toBe(8);
    // Window anchors at the FIRST write: expiry stays T0 + 60s despite the later increment.
    expect(
      await result(await object.fetch(rpc({ op: "getCounter", key: "c", now: T0 + 59_000 }))),
    ).toBe(8);
    expect(
      await result(await object.fetch(rpc({ op: "getCounter", key: "c", now: T0 + 60_000 }))),
    ).toBe(0);
  });

  it("resets an expired counter to the increment amount with a fresh window", async () => {
    const object = new OmniStorageDurableObject(fakeState());
    await object.fetch(rpc({ op: "increment", key: "c", amount: 5, ttlSeconds: 60, now: T0 }));
    const afterExpiry = T0 + 61_000;
    const reset = await object.fetch(
      rpc({ op: "increment", key: "c", amount: 2, ttlSeconds: 60, now: afterExpiry }),
    );
    expect(await result(reset)).toBe(2);
    expect(
      await result(
        await object.fetch(rpc({ op: "getCounter", key: "c", now: afterExpiry + 59_000 })),
      ),
    ).toBe(2);
    expect(
      await result(
        await object.fetch(rpc({ op: "getCounter", key: "c", now: afterExpiry + 60_000 })),
      ),
    ).toBe(0);
  });

  it("returns 0 for an absent counter", async () => {
    const object = new OmniStorageDurableObject(fakeState());
    expect(
      await result(await object.fetch(rpc({ op: "getCounter", key: "missing", now: T0 }))),
    ).toBe(0);
  });

  it("rejects unknown ops with 400", async () => {
    const object = new OmniStorageDurableObject(fakeState());
    const response = await object.fetch(rpc({ op: "compact", key: "k", now: T0 }));
    expect(response.status).toBe(400);
  });

  it("rejects non-POST requests with 400", async () => {
    const object = new OmniStorageDurableObject(fakeState());
    const response = await object.fetch(new Request("https://do.internal/", { method: "GET" }));
    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const object = new OmniStorageDurableObject(fakeState());
    const response = await object.fetch(
      new Request("https://do.internal/", { method: "POST", body: "{nope" }),
    );
    expect(response.status).toBe(400);
  });
});

/**
 * Namespace double that routes each object name to a dedicated real
 * OmniStorageDurableObject, mirroring production wiring — adapter tests
 * double as an integration test of both sides of the RPC.
 */
class FakeNamespace implements DurableObjectNamespaceLike {
  readonly names: string[] = [];
  private readonly objects = new Map<string, OmniStorageDurableObject>();

  idFromName(name: string): unknown {
    this.names.push(name);
    return { name };
  }

  get(id: unknown): DurableObjectStubLike {
    const { name } = id as { name: string };
    let object = this.objects.get(name);
    if (object === undefined) {
      object = new OmniStorageDurableObject(fakeState());
      this.objects.set(name, object);
    }
    const target = object;
    return { fetch: (input, init) => target.fetch(new Request(input, init)) };
  }

  objectCount(): number {
    return this.objects.size;
  }
}

function setup(): {
  clock: { now: number };
  namespace: FakeNamespace;
  adapter: DurableObjectStorageAdapter;
} {
  const clock = { now: T0 };
  const namespace = new FakeNamespace();
  const adapter = new DurableObjectStorageAdapter(namespace, { now: () => clock.now });
  return { clock, namespace, adapter };
}

function testRuntime(now: () => number): RuntimeContext {
  return {
    env: {},
    fetch: () => Promise.reject(new Error("network disabled in tests")),
    now,
    waitUntil: () => {},
    log: silentLogger,
  };
}

describe("DurableObjectStorageAdapter", () => {
  it("has the durable-object type", () => {
    expect(setup().adapter.type).toBe("durable-object");
  });

  it("round-trips put/get/delete through the object RPC", async () => {
    const { adapter } = setup();
    expect(await adapter.get("k")).toBeNull();
    await adapter.put("k", "v1");
    expect(await adapter.get("k")).toBe("v1");
    await adapter.delete("k");
    expect(await adapter.get("k")).toBeNull();
  });

  it("expires values using the injected clock", async () => {
    const { adapter, clock } = setup();
    await adapter.put("k", "v", { ttlSeconds: 60 });
    clock.now = T0 + 59_000;
    expect(await adapter.get("k")).toBe("v");
    clock.now = T0 + 60_000;
    expect(await adapter.get("k")).toBeNull();
  });

  it("counts exactly across increments and resets after expiry", async () => {
    const { adapter, clock } = setup();
    expect(await adapter.increment("c", 5, 60)).toBe(5);
    clock.now = T0 + 30_000;
    expect(await adapter.increment("c", 3, 60)).toBe(8);
    expect(await adapter.getCounter("c")).toBe(8);
    clock.now = T0 + 61_000;
    expect(await adapter.getCounter("c")).toBe(0);
    expect(await adapter.increment("c", 2, 60)).toBe(2);
  });

  it("routes every key to its own object", async () => {
    const { adapter, namespace } = setup();
    await adapter.put("a", "1");
    await adapter.put("b", "2");
    expect(namespace.objectCount()).toBe(2);
    expect(namespace.names).toEqual(["a", "b"]);
  });

  it("isolates adapters that share a namespace via the name prefix", async () => {
    const namespace = new FakeNamespace();
    const first = new DurableObjectStorageAdapter(namespace, { name: "one", now: () => T0 });
    const second = new DurableObjectStorageAdapter(namespace, { name: "two", now: () => T0 });
    await first.put("k", "from-one");
    await second.put("k", "from-two");
    expect(await first.get("k")).toBe("from-one");
    expect(await second.get("k")).toBe("from-two");
    expect(namespace.names).toContain("one:k");
    expect(namespace.names).toContain("two:k");
  });

  it("throws when the object responds with an error status", async () => {
    const failing: DurableObjectNamespaceLike = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => new Response("boom", { status: 500 }),
      }),
    };
    const adapter = new DurableObjectStorageAdapter(failing, { now: () => T0 });
    await expect(adapter.get("k")).rejects.toThrow("durable-object storage RPC failed (500)");
  });

  it("throws when the object responds with a malformed payload", async () => {
    const malformed: DurableObjectNamespaceLike = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => Response.json({ nope: true }),
      }),
    };
    const adapter = new DurableObjectStorageAdapter(malformed, { now: () => T0 });
    await expect(adapter.getCounter("k")).rejects.toThrow("malformed response");
  });

  it("throws when a counter op returns a non-numeric result", async () => {
    const wrongType: DurableObjectNamespaceLike = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => Response.json({ result: "eleven" }),
      }),
    };
    const adapter = new DurableObjectStorageAdapter(wrongType, { now: () => T0 });
    await expect(adapter.increment("k", 1, 60)).rejects.toThrow("non-numeric result");
  });
});

describe("createDurableObjectStorageFactory", () => {
  it("creates an adapter wired to the runtime clock and name option", async () => {
    const clock = { now: T0 };
    const namespace = new FakeNamespace();
    const factory = createDurableObjectStorageFactory(namespace);
    expect(factory.type).toBe("durable-object");
    const adapter = await factory.create(
      { type: "durable-object", name: "omni" },
      testRuntime(() => clock.now),
    );
    await adapter.put("k", "v", { ttlSeconds: 60 });
    expect(namespace.names).toEqual(["omni:k"]);
    expect(await adapter.get("k")).toBe("v");
    clock.now = T0 + 61_000;
    expect(await adapter.get("k")).toBeNull();
  });

  it("rejects unknown options with a ConfigError", () => {
    const factory = createDurableObjectStorageFactory(new FakeNamespace());
    expect(() =>
      factory.create(
        { type: "durable-object", objectName: "typo" },
        testRuntime(() => T0),
      ),
    ).toThrowError(ConfigError);
  });
});
