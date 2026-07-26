import { silentLogger } from "@omni-model/core";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src/server.js";

/**
 * Graceful shutdown over a real socket.
 *
 * `lifecycle.test.ts` in core covers the tracker itself; this is the part only a
 * real server can answer — that `close()` actually waits, that the response the
 * client is reading completes, and that a bounded timeout stops one slow client
 * from wedging a deploy.
 */

/** An upstream whose SSE body is released by the test. */
function gatedUpstream(): { fetch: typeof fetch; finish: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const encoder = new TextEncoder();
  const chunk = (delta: Record<string, unknown>): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);

  const impl: typeof fetch = async () => {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(chunk({ content: "first" }));
        await gate;
        controller.enqueue(chunk({ content: "last" }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: impl, finish: release };
}

const CONFIG = {
  version: 1,
  server: { logLevel: "silent" },
  storage: { type: "memory" },
  security: { providers: [{ type: "jwt", secret: "a-test-shared-secret-value" }] },
  routing: {
    rules: [
      {
        id: "main",
        when: "true",
        target: { type: "openai", apiKey: "sk-test", baseUrl: "https://upstream.test/v1" },
      },
    ],
  },
  // Nothing is asserted about logs here; keeping them on proves the flush on
  // shutdown does not throw.
  logging: { requests: true },
};

/** A HS256 token the configured jwt verifier accepts. */
async function bearer(): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ sub: "user-1", iat: now, exp: now + 3600 });
  const signature = createHmac("sha256", "a-test-shared-secret-value")
    .update(`${head}.${payload}`)
    .digest("base64url");
  return `Bearer ${head}.${payload}.${signature}`;
}

describe("graceful shutdown", () => {
  let running: RunningServer | undefined;
  let finishUpstream: (() => void) | undefined;

  afterEach(async () => {
    finishUpstream?.();
    await running?.close({ drainTimeoutMs: 1000 });
    running = undefined;
    finishUpstream = undefined;
  });

  async function serve(fetchImpl?: typeof fetch): Promise<string> {
    running = await startServer({
      config: CONFIG,
      port: 0,
      hostname: "127.0.0.1",
      logger: silentLogger,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
    return `http://127.0.0.1:${running.port}`;
  }

  it("lets a stream that started before shutdown finish", async () => {
    const upstream = gatedUpstream();
    finishUpstream = upstream.finish;
    const base = await serve(upstream.fetch);

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: await bearer() },
      body: JSON.stringify({
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(running?.inFlight()).toBe(1);

    // Shut down while the answer is half-written, then let the upstream finish.
    const closing = (running as RunningServer).close({ drainTimeoutMs: 5000 });
    upstream.finish();
    const text = await response.text();

    expect(text).toContain("first");
    expect(text).toContain("last");
    expect(text).toContain("[DONE]");
    await closing;
    running = undefined;
  }, 20_000);

  it("refuses new requests while draining, with a retryable status", async () => {
    const upstream = gatedUpstream();
    finishUpstream = upstream.finish;
    const base = await serve(upstream.fetch);

    const streaming = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: await bearer() },
      body: JSON.stringify({
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(streaming.status).toBe(200);

    const closing = (running as RunningServer).close({ drainTimeoutMs: 5000 });

    // Readiness fails immediately, which is what removes this instance from a
    // load balancer while the stream above is still being written.
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ status: "draining" });

    // Liveness still passes: the process is healthy, just not accepting work.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);

    const refused = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: await bearer() },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { code: "shutting_down" } });

    upstream.finish();
    await streaming.text();
    await closing;
    running = undefined;
  }, 20_000);

  it("gives up on a stream that outlives the drain timeout", async () => {
    // The property that matters for a deploy: a client that never finishes
    // reading cannot hold the process open indefinitely.
    const upstream = gatedUpstream();
    finishUpstream = upstream.finish;
    const base = await serve(upstream.fetch);

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: await bearer() },
      body: JSON.stringify({
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);

    const started = Date.now();
    await (running as RunningServer).close({ drainTimeoutMs: 150 });
    const elapsed = Date.now() - started;
    running = undefined;

    // Waited for the timeout, then stopped waiting.
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(10_000);

    // The abandoned body is not readable to the end; the point is only that we
    // are no longer waiting for it.
    await response.body?.cancel().catch(() => {});
  }, 20_000);

  it("closes cleanly and promptly with nothing in flight", async () => {
    await serve();
    const started = Date.now();
    await (running as RunningServer).close({ drainTimeoutMs: 5000 });
    running = undefined;
    // No in-flight work means no reason to wait at all.
    expect(Date.now() - started).toBeLessThan(2000);
  }, 20_000);

  it("is safe to close twice", async () => {
    await serve();
    const server = running as RunningServer;
    running = undefined;
    await server.close({ drainTimeoutMs: 1000 });
    // A second signal arriving after the first finished must not throw.
    await expect(server.close({ drainTimeoutMs: 1000 })).resolves.toBeUndefined();
  }, 20_000);
});
