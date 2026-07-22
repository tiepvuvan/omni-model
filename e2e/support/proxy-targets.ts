import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { type RunningServer, startServer } from "@omni-model/node";

/**
 * Helpers to stand up the omni-model proxy as either deploy target — the Node
 * server (`@omni-model/node`) or the real Cloudflare worker in **workerd** (via
 * `wrangler dev`) — behind one `{ base, stop }` interface, so a suite can run
 * the same assertions against both. Used by the auth e2e to prove Firebase Auth
 * / App Check work identically on the container and the edge.
 */
export interface RunningTarget {
  /** Base URL, e.g. http://127.0.0.1:8801 */
  base: string;
  stop: () => Promise<void>;
}

/** Boot the Node server with a JSON configuration document. */
export async function startNodeTarget(
  configJson: string,
  env: NodeJS.ProcessEnv,
): Promise<RunningTarget> {
  const server: RunningServer = await startServer({
    config: JSON.parse(configJson) as Record<string, unknown>,
    env,
    port: 0,
    hostname: "127.0.0.1",
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    stop: () => server.close(),
  };
}

/** Resolve the wrangler CLI entry (a devDependency of apps/cloudflare). */
function wranglerBin(): string {
  const anchor = fileURLToPath(new URL("../../apps/cloudflare/package.json", import.meta.url));
  const require = createRequire(anchor);
  const pkgPath = require.resolve("wrangler/package.json");
  const bin = (require(pkgPath) as { bin: Record<string, string> }).bin.wrangler;
  return fileURLToPath(new URL(bin, `file://${pkgPath}`));
}

async function waitForHealthz(base: string, deadlineMs: number, log: () => string): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`worker did not become healthy on ${base} within ${deadlineMs}ms\n${log()}`);
}

export interface WorkerTargetOptions {
  /** Full JSON config, injected through the normal `OMNI_CONFIG_JSON` variable. */
  omniConfigJson: string;
  /** Extra vars for `${...}` interpolation (secrets + ids). Never written to disk. */
  vars: Record<string, string>;
  port: number;
}

/**
 * Boot the real worker in workerd via `wrangler dev`, reconfigured at runtime
 * with `OMNI_CONFIG_JSON` (the same configuration path a deployer uses). The
 * config + secrets are passed as `--var`, so nothing lands in a `.dev.vars`
 * file. Requires a prior `pnpm build` (the worker bundles the built dist).
 */
export async function startWorkerTarget(opts: WorkerTargetOptions): Promise<RunningTarget> {
  const config = fileURLToPath(new URL("../cloudflare/wrangler.jsonc", import.meta.url));
  const varArgs = Object.entries({ ...opts.vars, OMNI_CONFIG_JSON: opts.omniConfigJson }).flatMap(
    ([k, v]) => ["--var", `${k}:${v}`],
  );
  const child: ChildProcess = spawn(
    process.execPath,
    [
      wranglerBin(),
      "dev",
      "--config",
      config,
      "--ip",
      "127.0.0.1",
      "--port",
      String(opts.port),
      "--local",
      "--log-level",
      "warn",
      ...varArgs,
    ],
    {
      cwd: fileURLToPath(new URL("../cloudflare", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    },
  );
  let logBuf = "";
  child.stdout?.on("data", (b) => {
    logBuf += String(b);
  });
  child.stderr?.on("data", (b) => {
    logBuf += String(b);
  });

  const base = `http://127.0.0.1:${opts.port}`;
  await waitForHealthz(base, 90_000, () => `--- wrangler output ---\n${logBuf}`);

  return {
    base,
    stop: async () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    },
  };
}
