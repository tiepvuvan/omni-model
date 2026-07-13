#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolveConfigSource } from "./config.js";
import { startServer } from "./server.js";

const USAGE = `omni-model — self-hosted OpenAI-compatible AI proxy

Usage: omni-model [options]

Options:
  -c, --config <path>  Path to the YAML configuration file
  -p, --port <n>       Port to listen on (default: $PORT or 8787)
  -h, --help           Show this help and exit

Configuration is resolved from, in order: --config, the OMNI_CONFIG
environment variable (inline YAML), the OMNI_CONFIG_PATH environment
variable (a file path), or ./omni.yaml.`;

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port "${raw}": expected an integer between 0 and 65535`);
  }
  return port;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: "string", short: "c" },
      port: { type: "string", short: "p" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help === true) {
    console.log(USAGE);
    return;
  }

  const port = values.port === undefined ? undefined : parsePort(values.port);
  const { yaml, source } = await resolveConfigSource({
    cliPath: values.config,
    env: process.env,
    cwd: process.cwd(),
  });
  const server = await startServer({ configYaml: yaml, env: process.env, port });
  console.log(
    `omni-model listening on http://${server.hostname}:${server.port} (config: ${source})`,
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    // Guard against a second signal (e.g. SIGINT then SIGTERM) closing twice.
    if (shuttingDown) return;
    shuttingDown = true;
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  // Startup errors (bad config, port in use) are user errors: message only, no stack.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
