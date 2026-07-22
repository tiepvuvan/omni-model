import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authHeaders } from "./support/auth.js";

/**
 * End-to-end: the real omni-model Cloudflare Worker, running in **workerd** via
 * `wrangler dev`, → OpenRouter. This is the same `createWorker` factory and
 * `OmniStorageDurableObject` that ship in apps/cloudflare — proving the
 * worker-specific surface the Node suite can't: the Workers runtime boots and
 * parses config, outbound `fetch` reaches a real upstream, SSE **streaming**
 * survives workerd, and **Durable Object** storage backs the rate limiter.
 *
 * Opt-in: set `OPENROUTER_API_KEY` (and optionally `OMNI_E2E_MODEL`). Skipped
 * otherwise. Requires a prior `pnpm build` (the worker bundles the built
 * @omni-model/cloudflare + core from dist).
 *
 *   OPENROUTER_API_KEY=... pnpm test:e2e
 */
const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OMNI_E2E_MODEL ?? "openai/gpt-4o-mini";
const PORT = Number(process.env.OMNI_E2E_WORKER_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const WRANGLER_CONFIG = fileURLToPath(new URL("./cloudflare/wrangler.jsonc", import.meta.url));
const CONFIG_JSON = readFileSync(
  fileURLToPath(new URL("./cloudflare/omni.e2e.worker.json", import.meta.url)),
  "utf8",
);

/**
 * Resolve the wrangler CLI entry. wrangler is a devDependency of
 * apps/cloudflare (not the repo root), so resolution is based there.
 */
function wranglerBin(): string {
  const anchor = fileURLToPath(new URL("../apps/cloudflare/package.json", import.meta.url));
  const require = createRequire(anchor);
  const pkgPath = require.resolve("wrangler/package.json");
  const bin = (require(pkgPath) as { bin: Record<string, string> }).bin.wrangler;
  return fileURLToPath(new URL(bin, `file://${pkgPath}`));
}

async function waitForHealthz(deadlineMs: number): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.status === 200) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`worker did not become healthy on ${BASE} within ${deadlineMs}ms`);
}

describe.skipIf(!KEY)("E2E: omni-model Cloudflare Worker (workerd) → OpenRouter", () => {
  let child: ChildProcess;

  beforeAll(async () => {
    // `--var OPENROUTER_API_KEY:<key>` injects the key straight into the worker
    // env — no `.dev.vars` file, so the key never touches disk. `--local` keeps
    // bindings (the Durable Object) in-process; outbound fetch still hits the net.
    child = spawn(
      process.execPath,
      [
        wranglerBin(),
        "dev",
        "--config",
        WRANGLER_CONFIG,
        "--ip",
        "127.0.0.1",
        "--port",
        String(PORT),
        "--local",
        "--var",
        `OPENROUTER_API_KEY:${KEY}`,
        "--var",
        `OMNI_CONFIG_JSON:${CONFIG_JSON}`,
        "--log-level",
        "warn",
      ],
      {
        cwd: fileURLToPath(new URL("./cloudflare", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group so we can tear down workerd (a grandchild) too.
        detached: true,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
      },
    );
    let log = "";
    child.stdout?.on("data", (b) => {
      log += String(b);
    });
    child.stderr?.on("data", (b) => {
      log += String(b);
    });
    child.on("exit", (code) => {
      if (code && code !== 0) console.error(`wrangler dev exited ${code}:\n${log}`);
    });

    // First run may download the workerd binary — allow generous headroom.
    await waitForHealthz(90_000).catch((e) => {
      throw new Error(`${e}\n--- wrangler output ---\n${log}`);
    });
  }, 100_000);

  afterAll(async () => {
    if (child?.pid) {
      try {
        // Kill the whole process group (wrangler + workerd child).
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  });

  // A verifier is mandatory, so every request carries the suite's token.
  const post = async (body: unknown): Promise<Response> =>
    fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify(body),
    });

  it("boots in workerd and serves /healthz", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
  });

  it("completes a non-streaming chat through the worker", { timeout: 30_000 }, async () => {
    const res = await post({
      model: MODEL,
      messages: [{ role: "user", content: 'Reply with exactly the word "pong" and nothing else.' }],
      max_tokens: 10,
      temperature: 0,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      choices: { message: { content: string | null } }[];
      usage?: { total_tokens: number };
    };
    expect(json.choices[0]?.message.content?.toLowerCase()).toContain("pong");
    expect(json.usage?.total_tokens ?? 0).toBeGreaterThan(0);
  });

  it("streams SSE deltas + a final usage chunk through workerd", { timeout: 30_000 }, async () => {
    const res = await post({
      model: MODEL,
      messages: [{ role: "user", content: "Count from 1 to 5, space-separated." }],
      max_tokens: 30,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const raw = await res.text();
    expect(raw).toContain("data: ");
    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);

    let content = "";
    let sawUsage = false;
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      const chunk = JSON.parse(payload) as {
        choices?: { delta?: { content?: string } }[];
        usage?: { total_tokens: number } | null;
      };
      content += chunk.choices?.[0]?.delta?.content ?? "";
      if (chunk.usage) sawUsage = true;
    }
    expect(content.length).toBeGreaterThan(0);
    expect(sawUsage).toBe(true);
  });

  it("enforces the Durable Object rate limit (429 after the bucket drains)", async () => {
    // The config caps ip requests at 5/min. Two metered requests were already
    // spent above; a short burst of tiny requests must therefore produce at
    // least one 429 — which can only happen if the DO counter genuinely
    // increments and persists across requests inside workerd (a broken/fail-open
    // store would let every request through). 429s are returned before routing,
    // so the blocked ones cost no upstream tokens.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await post({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      });
      statuses.push(res.status);
      await res.arrayBuffer(); // drain the body
    }
    expect(statuses, `statuses: ${statuses.join(",")}`).toContain(429);
  });
});
