#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolveConfigSource } from "./config.js";
import { createFirstOperator } from "./create-admin.js";
import { startServer } from "./server.js";

const USAGE = `omni-model — self-hosted OpenAI-compatible AI proxy

Usage:
  omni-model [options]                       Serve the proxy (default)
  omni-model create-admin --email <e>        Create an operator account

Options:
  -p, --port <n>       Port to listen on (default: $PORT or 8787)
      --email <e>      Operator email (create-admin)
      --password <p>   Operator password; or set OMNI_ADMIN_PASSWORD (create-admin)
      --name <n>       Operator display name (create-admin)
  -h, --help           Show this help and exit

Configuration lives in the database and is reloaded without a restart. On first boot
an empty database is seeded from the environment: OMNI_STORAGE_TYPE,
OMNI_SECURITY_<VERIFIER>_*, and OMNI_PROVIDERS_DEFAULT_*, or JSON blocks and
OMNI__... paths for complex multi-provider routing.

With no configuration at all the server still starts: /healthz answers, /v1/*
returns 503, and /readyz explains what is missing.

Set OMNI_ADMIN_SECRET to enable the admin API at /admin/api. The first operator can
sign up through it while no account exists, or be created with create-admin.`;

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port "${raw}": expected an integer between 0 and 65535`);
  }
  return port;
}

async function serve(port: number | undefined): Promise<void> {
  const { config, source } = resolveConfigSource({ env: process.env });
  const server = await startServer({
    ...(config === undefined ? {} : { config }),
    env: process.env,
    port,
  });
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

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p" },
      email: { type: "string" },
      password: { type: "string" },
      name: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help === true) {
    console.log(USAGE);
    return;
  }

  const command = positionals[0] ?? "serve";
  if (command === "create-admin") {
    // Password from the environment by default, so it does not land in shell
    // history or a process listing.
    const password = values.password ?? process.env.OMNI_ADMIN_PASSWORD;
    if (values.email === undefined || password === undefined) {
      throw new Error(
        "create-admin needs --email and a password (--password or OMNI_ADMIN_PASSWORD)",
      );
    }
    const operator = await createFirstOperator({
      env: process.env,
      email: values.email,
      password,
      ...(values.name === undefined ? {} : { name: values.name }),
    });
    console.log(`created operator ${operator.email} with the admin role`);
    return;
  }
  if (command !== "serve") {
    throw new Error(`unknown command "${command}". Try: omni-model --help`);
  }

  await serve(values.port === undefined ? undefined : parsePort(values.port));
}

main().catch((error: unknown) => {
  // Startup errors (bad config, port in use) are user errors: message only, no stack.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
