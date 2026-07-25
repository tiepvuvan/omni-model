#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolveConfigSource } from "./config.js";
import { createFirstOperator } from "./create-admin.js";
import { importConfig } from "./import-config.js";
import { applyMigrations } from "./migrate.js";
import { startServer } from "./server.js";

const USAGE = `omni-model — self-hosted OpenAI-compatible AI proxy

Usage:
  omni-model [options]                       Serve the proxy (default)
  omni-model migrate                         Apply pending schema migrations and exit
  omni-model import-config <file.json>       Save a configuration as a new revision
  omni-model create-admin --email <e>        Create an operator account

Options:
  -p, --port <n>       Port to listen on (default: $PORT or 8787)
      --email <e>      Operator email (create-admin)
      --password <p>   Operator password; or set OMNI_ADMIN_PASSWORD (create-admin)
      --name <n>       Operator display name (create-admin)
      --note <n>       Audit note recorded with the revision (import-config)
  -h, --help           Show this help and exit

Configuration lives in the database and is reloaded without a restart. On first boot
an empty database is seeded from the environment: OMNI_STORAGE_TYPE,
OMNI_SECURITY_<VERIFIER>_*, and OMNI_PROVIDERS_DEFAULT_*, or JSON blocks and
OMNI__... paths for complex multi-provider routing.

With no configuration at all the server still starts: /healthz answers, /v1/*
returns 503, and /readyz explains what is missing.

Set OMNI_ADMIN_SECRET to enable the admin API at /admin/api. The first operator can
sign up through it while no account exists, or be created with create-admin.

SIGTERM drains in-flight requests, including streams still being written, before
exiting. OMNI_SHUTDOWN_DRAIN_MS bounds the wait (default 25000). A second signal
exits immediately.`;

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
  const shutdown = (signal: string): void => {
    // A second signal means "stop waiting": the first drains, the second exits.
    // Without that escape hatch, Ctrl-C during a long stream looks like a hang.
    if (shuttingDown) {
      console.error(`${signal} again: exiting without finishing in-flight requests`);
      process.exit(130);
    }
    shuttingDown = true;
    console.log(`${signal} received: draining ${server.inFlight()} in-flight request(s)`);
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

type Values = {
  port?: string;
  email?: string;
  password?: string;
  name?: string;
  note?: string;
  help?: boolean;
};

async function createAdmin(values: Values): Promise<void> {
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
}

async function migrate(): Promise<void> {
  const result = await applyMigrations({ env: process.env });
  console.log(
    result.applied.length === 0
      ? `schema is already at version ${result.version}`
      : `applied migration(s) ${result.applied.join(", ")}; schema is at version ${result.version}`,
  );
  if (result.ahead !== undefined) {
    console.log(
      `note: the database is at version ${result.ahead}, ahead of this build — a newer ` +
        "instance has already migrated it",
    );
  }
}

async function importConfigCommand(file: string | undefined, values: Values): Promise<void> {
  if (file === undefined) {
    throw new Error("import-config needs a path to a JSON configuration document");
  }
  const saved = await importConfig({
    env: process.env,
    file,
    ...(values.note === undefined ? {} : { note: values.note }),
  });
  console.log(
    `saved revision ${saved.revision} from ${file}; every running instance will adopt it`,
  );
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
      note: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help === true) {
    console.log(USAGE);
    return;
  }

  switch (positionals[0] ?? "serve") {
    case "serve":
      return serve(values.port === undefined ? undefined : parsePort(values.port));
    case "migrate":
      return migrate();
    case "import-config":
      return importConfigCommand(positionals[1], values);
    case "create-admin":
      return createAdmin(values);
    default:
      throw new Error(`unknown command "${positionals[0]}". Try: omni-model --help`);
  }
}

main().catch((error: unknown) => {
  // Startup errors (bad config, port in use) are user errors: message only, no stack.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
