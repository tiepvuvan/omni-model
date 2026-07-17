import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end: the **forkless** deploy path — the prebuilt worker artifact.
 *
 * Builds the release artifact exactly as `release-worker.yml` does, then stands
 * up a directory containing *only* the two files a deployer downloads (the
 * prebuilt `worker.js` + the shipped `prebuilt/wrangler.jsonc` template) — no
 * package.json, no node_modules, no source — and serves it from workerd.
 *
 * Two regressions this pins:
 *  1. **The artifact must stay a single self-contained file.** Re-adding a
 *     `.yaml` import to the prebuilt entry would make wrangler emit a separate
 *     hashed sidecar, silently turning the release into two coupled files.
 *  2. **The Durable Object binding must actually work.** Rate limiting is
 *     fail-open (CLAUDE.md rule 7), so a dead OMNI_DO would let every request
 *     through and look fine — only a real 429 proves the counter is live.
 *
 * Needs no API keys and no network: the 429 is returned before routing, so the
 * upstream is deliberately a dead address.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.OMNI_E2E_PREBUILT_PORT ?? 8830);
const BASE = `http://127.0.0.1:${PORT}`;

/** The whole configuration a forkless deployer supplies — one var, no file. */
const OMNI_CONFIG = `version: 1
storage:
  type: durable-object
  binding: OMNI_DO
security:
  providers: []
rateLimits:
  - name: per-ip
    key: ip
    requests: { limit: 1, window: 1m }
providers:
  stub:
    type: openai-compatible
    baseUrl: http://127.0.0.1:9
routing:
  defaultProvider: stub
`;

function wranglerBin(): string {
  const anchor = join(repoRoot, "apps/cloudflare/package.json");
  const require = createRequire(anchor);
  const pkgPath = require.resolve("wrangler/package.json");
  const bin = (require(pkgPath) as { bin: Record<string, string> }).bin.wrangler;
  return fileURLToPath(new URL(bin, `file://${pkgPath}`));
}

function run(args: string[], cwd: string): { code: number; out: string } {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const r = spawnSync(process.execPath, [wranglerBin(), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("E2E: prebuilt worker artifact (forkless deploy)", () => {
  let child: ChildProcess | undefined;
  let emitted: string[] = [];
  let bundle = "";

  beforeAll(async () => {
    // 1. Build the artifact the way the release workflow does.
    const outDir = mkdtempSync(join(tmpdir(), "omni-prebuilt-"));
    const build = run(
      ["deploy", "--dry-run", "--outdir", outDir, "--config", "wrangler.prebuilt.jsonc"],
      join(repoRoot, "apps/cloudflare"),
    );
    expect(build.code, `wrangler build failed:\n${build.out}`).toBe(0);
    emitted = readdirSync(outDir).filter((f) => f.endsWith(".js"));
    bundle = readFileSync(join(outDir, emitted[0] as string), "utf8");

    // 2. Assemble exactly what a deployer downloads: the artifact + the template.
    const userDir = mkdtempSync(join(tmpdir(), "omni-forkless-"));
    cpSync(join(outDir, emitted[0] as string), join(userDir, "worker.js"));
    cpSync(
      join(repoRoot, "apps/cloudflare/prebuilt/wrangler.jsonc"),
      join(userDir, "wrangler.jsonc"),
    );

    // 3. Serve it — no build, no deps, config from the OMNI_CONFIG var only.
    child = spawn(
      process.execPath,
      [
        wranglerBin(),
        "dev",
        "--ip",
        "127.0.0.1",
        "--port",
        String(PORT),
        "--local",
        "--log-level",
        "warn",
        "--var",
        `OMNI_CONFIG:${OMNI_CONFIG}`,
      ],
      {
        cwd: userDir,
        stdio: ["ignore", "pipe", "pipe"],
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

    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/healthz`)).status === 200) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`prebuilt worker never became healthy\n${log}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 150_000);

  afterAll(async () => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  });

  it("emits exactly one self-contained .js (no yaml sidecar, no imports)", () => {
    expect(emitted, `emitted: ${emitted.join(", ")}`).toHaveLength(1);
    // A re-added `import ... from "../omni.yaml"` would show up as a top-level
    // import and a separate emitted file — the release would silently break.
    expect(bundle.match(/^\s*import\s+.*?from\s+["'][^"']+["']/m)).toBeNull();
    expect(bundle.match(/\brequire\(["'][^"']+["']\)/)).toBeNull();
    // Node builtins would mean it can't run on workerd. Match real module
    // specifiers only — a bare "node:" substring also hits the YAML library's
    // `node: null` properties.
    expect(bundle.match(/["']node:[a-z_/]+["']/)).toBeNull();
  });

  it("serves from the shipped template with config from OMNI_CONFIG alone", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
  });

  it("enforces the Durable Object rate limit (proves OMNI_DO is live)", async () => {
    // limit is 1/min: the 2nd request must be refused. Rate limiting fails OPEN,
    // so without a working DO binding this would pass through instead.
    const send = (): Promise<Response> =>
      fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
      });
    const first = await send();
    await first.body?.cancel();
    const second = await send();
    await second.body?.cancel();
    expect(second.status).toBe(429);
  });
});
