import { describe, expect, it } from "vitest";
import { MemoryConfigStore } from "../../src/configstore/memory.js";

describe("MemoryConfigStore", () => {
  it("starts empty", async () => {
    const store = new MemoryConfigStore();
    expect(await store.loadActive()).toBeNull();
    expect(await store.history()).toEqual([]);
  });

  it("numbers revisions and keeps exactly one active", async () => {
    const store = new MemoryConfigStore(() => 1000);

    const first = await store.save({ a: 1 }, { createdBy: "alice", note: "initial" });
    expect(first).toMatchObject({ revision: 1, createdBy: "alice", note: "initial" });

    const second = await store.save({ a: 2 });
    expect(second.revision).toBe(2);
    expect(await store.loadActive()).toMatchObject({ revision: 2, document: { a: 2 } });

    const history = await store.history();
    expect(history.map((entry) => [entry.revision, entry.active])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it("keeps history readable after it stops being active", async () => {
    // Rollback depends on this: an old document has to still be fetchable.
    const store = new MemoryConfigStore();
    await store.save({ generation: 1 });
    await store.save({ generation: 2 });

    expect(await store.get(1)).toMatchObject({ document: { generation: 1 } });
    expect(await store.get(99)).toBeNull();
  });

  it("detaches stored documents so history cannot be rewritten", async () => {
    // A real database copies on write; the in-memory store must not hand out a
    // live reference that a caller could mutate after the fact.
    const store = new MemoryConfigStore();
    const document: { nested: { value: number } } = { nested: { value: 1 } };
    await store.save(document);

    document.nested.value = 999;
    expect(await store.loadActive()).toMatchObject({ document: { nested: { value: 1 } } });

    const loaded = await store.loadActive();
    if (loaded === null) throw new Error("expected an active revision");
    // Mutating what we were handed must not reach back into the store either.
    (loaded.document as { nested: { value: number } }).nested.value = 42;
    expect(await store.loadActive()).toMatchObject({ document: { nested: { value: 1 } } });
  });

  it("notifies watchers of the new revision and stops on unsubscribe", async () => {
    const store = new MemoryConfigStore();
    const seen: number[] = [];
    const unwatch = store.watch((revision) => seen.push(revision));

    await store.save({ a: 1 });
    await store.save({ a: 2 });
    unwatch();
    await store.save({ a: 3 });

    expect(seen).toEqual([1, 2]);
  });

  it("respects the history limit, newest first", async () => {
    const store = new MemoryConfigStore();
    for (let i = 0; i < 5; i += 1) await store.save({ i });
    expect((await store.history(2)).map((entry) => entry.revision)).toEqual([5, 4]);
  });
});
