import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import { CHAT_BODY, chatRequest, createTestApp, FIXED_NOW } from "./helpers.js";

/**
 * The per-user in-flight bound.
 *
 * This is the answer to the hole post-paid token accounting leaves: a budget is
 * checked against what was spent *before* a request, so fifty simultaneous
 * requests are all admitted against the same empty counter and the budget is
 * blown fifty times over before the first response lands. Capping how many a user
 * can have running at once is what closes it.
 */
describe("concurrency limiting", () => {
  const fixture = (perUser: number, extra = ""): string => `
version: 1
concurrency: { perUser: ${perUser} }
rateLimits: []
${extra}routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`;

  /**
   * A provider that parks until released, so requests really do overlap.
   *
   * The bound is about simultaneity, and a test whose requests complete instantly
   * would pass with no bound at all.
   */
  function parked() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release: () => release() };
  }

  it("refuses a request past the limit, and says so as a 429", async () => {
    const { gate, release } = parked();
    const { app } = await createTestApp({
      yaml: fixture(2),
      behaviors: { fake: { chatDelay: gate } },
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
    });

    const first = app.fetch(chatRequest(CHAT_BODY));
    const second = app.fetch(chatRequest(CHAT_BODY));
    const third = await app.fetch(chatRequest(CHAT_BODY));

    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("1");
    expect(third.headers.get("x-ratelimit-concurrency")).toBe("2");
    const body = (await third.json()) as { error: { code: string; message: string } };
    // A distinct code from a budget 429, because the remedy is different: wait for
    // your own requests to finish, not for a window to roll over.
    expect(body.error.code).toBe("concurrency_limit_exceeded");
    expect(body.error.message).toContain("2 requests in flight");

    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it("gives the slot back when the response completes", async () => {
    const { gate, release } = parked();
    const { app } = await createTestApp({
      yaml: fixture(1),
      behaviors: { fake: { chatDelay: gate } },
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
    });

    const held = app.fetch(chatRequest(CHAT_BODY));
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(429);

    release();
    await held;

    // A bound that never released would turn one slow request into a permanent
    // lockout, which is worse than the attack it prevents.
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);
  });

  it("holds the slot for a stream until the body is finished", async () => {
    // `streamGate` keeps the upstream stream open after its chunks, which is what
    // makes "the handler returned but the response is still being written"
    // observable at all.
    const { gate, release } = parked();
    const { app, collector } = await createTestApp({
      yaml: fixture(1),
      behaviors: {
        fake: {
          streamChunks: [
            { id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [] },
          ],
          streamGate: gate,
        },
      },
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
    });

    const streaming = await app.fetch(chatRequest({ ...CHAT_BODY, stream: true }));
    expect(streaming.status).toBe(200);

    // A stream spends almost its whole life after the handler returned, so a slot
    // released at `return` would measure nothing at all.
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(429);

    release();
    await streaming.text();
    await collector.flush();

    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);
  });

  it("gives the slot back when the upstream fails", async () => {
    const { app } = await createTestApp({
      yaml: fixture(1),
      behaviors: {
        fake: { error: { status: 502, body: { error: { message: "upstream down" } } } },
      },
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
    });

    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(502);
    // A failing upstream must not leak slots — that turns a provider outage into a
    // lockout that outlives it.
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(502);
  });

  it("counts per user, not across the deployment", async () => {
    const { gate, release } = parked();
    const { app } = await createTestApp({
      yaml: fixture(1, "security:\n  userAuth:\n    type: fake-auth\n"),
      behaviors: { fake: { chatDelay: gate } },
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
    });

    const alice = app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "alice" }));
    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "alice" }))).status).toBe(429);
    // Bob is not affected by Alice's slot.
    const bob = app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "bob" }));

    release();
    expect((await alice).status).toBe(200);
    expect((await bob).status).toBe(200);
  });

  it("is off when perUser is 0", async () => {
    const { gate, release } = parked();
    const { app } = await createTestApp({
      yaml: fixture(0),
      behaviors: { fake: { chatDelay: gate } },
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
    });

    const many = Array.from({ length: 10 }, () => app.fetch(chatRequest(CHAT_BODY)));
    release();

    const statuses = await Promise.all(many.map(async (call) => (await call).status));
    expect(new Set(statuses)).toEqual(new Set([200]));
  });

  it("defaults to three, without being configured at all", async () => {
    const { gate, release } = parked();
    const yaml = `
version: 1
rateLimits: []
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`;
    const { app } = await createTestApp({
      yaml,
      behaviors: { fake: { chatDelay: gate } },
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
    });

    const held = Array.from({ length: 3 }, () => app.fetch(chatRequest(CHAT_BODY)));
    // On by default: the attack it closes does not require any configuration to
    // work, so neither should the defence.
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(429);

    release();
    for (const call of held) expect((await call).status).toBe(200);
  });
});
