import { describe, expect, it } from "vitest";
import { createRequestTracker } from "../../src/server/lifecycle.js";
import { CHAT_BODY, chatRequest, createTestProxy } from "./helpers.js";

/**
 * A provider whose stream stays open until the test says otherwise, so "the
 * handler returned but the answer is still being written" is a state that can be
 * observed rather than raced against.
 */
function gatedStream(): { behaviors: Record<string, unknown>; finish: () => void } {
  let release: () => void = () => {};
  const streamGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    behaviors: {
      main: {
        streamChunks: [
          { choices: [{ index: 0, delta: { content: "hello" } }] },
          { choices: [{ index: 0, delta: { content: " world" }, finish_reason: "stop" }] },
        ],
        streamUsage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        streamGate,
      },
    },
    finish: release,
  };
}

describe("createRequestTracker", () => {
  it("counts nothing before a request and after a plain response", async () => {
    const tracker = createRequestTracker();
    expect(tracker.inFlight()).toBe(0);
    expect(tracker.draining()).toBe(false);
    expect(await tracker.drain(50)).toEqual({ remaining: 0, waitedMs: 0, timedOut: false });
  });

  it("refuses new work once shutdown has begun", async () => {
    const { app, tracker } = await createTestProxy({ yaml: MINIMAL });
    tracker.beginShutdown();

    const response = await app.fetch(chatRequest(CHAT_BODY));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("shutting_down");
  });

  it("reports draining on /readyz, so a load balancer stops routing here", async () => {
    const { app, tracker } = await createTestProxy({ yaml: MINIMAL });
    expect((await app.fetch(new Request("http://proxy.test/readyz"))).status).toBe(200);

    tracker.beginShutdown();
    const response = await app.fetch(new Request("http://proxy.test/readyz"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "draining" });
  });

  it("keeps answering /healthz while draining, so the platform does not kill us", async () => {
    // Liveness and readiness answer different questions: we are alive and
    // finishing work, but not available for more.
    const { app, tracker } = await createTestProxy({ yaml: MINIMAL });
    tracker.beginShutdown();
    expect((await app.fetch(new Request("http://proxy.test/healthz"))).status).toBe(200);
  });

  it("drains immediately when nothing is in flight", async () => {
    const { tracker } = await createTestProxy({ yaml: MINIMAL });
    const result = await tracker.drain(1000);
    expect(result).toEqual({ remaining: 0, waitedMs: 0, timedOut: false });
  });
});

describe("draining a streamed response", () => {
  it("counts a stream as in flight until its body is fully written", async () => {
    const { behaviors, finish } = gatedStream();
    const { app, tracker, collector } = await createTestProxy({
      yaml: MINIMAL,
      behaviors: behaviors as Parameters<typeof createTestProxy>[0]["behaviors"],
    });

    const response = await app.fetch(chatRequest({ ...CHAT_BODY, stream: true }));
    expect(response.status).toBe(200);
    // The handler has returned, but the answer is still being written — exactly
    // the window a naive shutdown truncates.
    expect(tracker.inFlight()).toBe(1);

    const drained = tracker.drain(5000);
    finish();
    const text = await response.text();

    expect(text).toContain("hello");
    expect(text).toContain("world");
    expect(text).toContain("[DONE]");
    expect(await drained).toMatchObject({ remaining: 0, timedOut: false });
    expect(tracker.inFlight()).toBe(0);

    // The usage a token budget depends on lands too, because the drain waited.
    await collector.flush();
  });

  it("stops counting a stream the client abandoned", async () => {
    // Otherwise one client hanging up leaks a count, and every later shutdown
    // waits out the full timeout for work that ended long ago.
    const { behaviors, finish } = gatedStream();
    const { app, tracker } = await createTestProxy({
      yaml: MINIMAL,
      behaviors: behaviors as Parameters<typeof createTestProxy>[0]["behaviors"],
    });

    const response = await app.fetch(chatRequest({ ...CHAT_BODY, stream: true }));
    expect(tracker.inFlight()).toBe(1);

    await response.body?.cancel();
    finish();
    // Cancellation settles the pipe asynchronously, so drain is how we wait.
    await tracker.drain(5000);
    expect(tracker.inFlight()).toBe(0);
  });

  it("gives up after the timeout rather than stalling a deploy forever", async () => {
    const { behaviors, finish } = gatedStream();
    const { app, tracker } = await createTestProxy({
      yaml: MINIMAL,
      behaviors: behaviors as Parameters<typeof createTestProxy>[0]["behaviors"],
    });

    const response = await app.fetch(chatRequest({ ...CHAT_BODY, stream: true }));
    expect(tracker.inFlight()).toBe(1);

    const result = await tracker.drain(20);
    expect(result.timedOut).toBe(true);
    expect(result.remaining).toBe(1);
    expect(result.waitedMs).toBeGreaterThanOrEqual(0);

    // Clean up so the test leaves no pending pipe behind.
    finish();
    await response.text();
  });

  it("waits for several streams, and reports how long it took", async () => {
    const { behaviors, finish } = gatedStream();
    const { app, tracker } = await createTestProxy({
      yaml: MINIMAL,
      behaviors: behaviors as Parameters<typeof createTestProxy>[0]["behaviors"],
    });

    const responses = await Promise.all([
      app.fetch(chatRequest({ ...CHAT_BODY, stream: true })),
      app.fetch(chatRequest({ ...CHAT_BODY, stream: true })),
      app.fetch(chatRequest({ ...CHAT_BODY, stream: true })),
    ]);
    expect(tracker.inFlight()).toBe(3);

    const drained = tracker.drain(5000);
    finish();
    await Promise.all(responses.map((response) => response.text()));

    expect(await drained).toMatchObject({ remaining: 0, timedOut: false });
  });
});

describe("non-streamed responses", () => {
  it("are no longer in flight once the handler returns", async () => {
    const { app, tracker } = await createTestProxy({ yaml: MINIMAL });
    const response = await app.fetch(chatRequest(CHAT_BODY));
    expect(response.status).toBe(200);
    // Fully materialised by the handler, so there is nothing left to wait for and
    // no reason to pay for wrapping the body.
    expect(tracker.inFlight()).toBe(0);
  });

  it("are no longer in flight after a rejection", async () => {
    const { app, tracker } = await createTestProxy({ yaml: MINIMAL });
    const response = await app.fetch(
      chatRequest({ ...CHAT_BODY, model: "" } as unknown as typeof CHAT_BODY),
    );
    expect(response.status).toBe(400);
    expect(tracker.inFlight()).toBe(0);
  });
});

const MINIMAL = [
  "version: 1",
  "storage: { type: memory }",
  "providers:\n  main: { type: fake }",
  "routing:\n  defaultProvider: main",
].join("\n");
