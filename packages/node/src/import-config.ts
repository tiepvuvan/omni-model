import { readFile } from "node:fs/promises";
import {
  CelExpressionEngine,
  ConfigError,
  createBundleHolder,
  createConsoleLogger,
  EnvelopeSecretStore,
  keyringFromEnv,
  type Logger,
  MemoryStorageAdapter,
  type RuntimeContext,
  type StoredConfig,
} from "@omni-model/core";
import { createPgPool, PostgresConfigStore, PostgresSecretRowStore } from "@omni-model/postgres";
import { postgresUrl } from "./bootstrap.js";
import { containerRegistry } from "./registry.js";

export interface ImportConfigArgs {
  env: Record<string, string | undefined>;
  /** Path to a JSON configuration document. */
  file: string;
  note?: string;
  createdBy?: string;
  logger?: Logger;
}

/** Read and parse the document, with a message that names the file. */
async function readDocument(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new ConfigError(
      `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigError(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Save a JSON configuration document as a new revision.
 *
 * This is the version-controlled path to the same thing `PUT /admin/api/config`
 * does: a configuration lives in a repository, and CI applies it. Every running
 * replica picks the revision up through the config store's change feed, so no
 * restart and no admin session are involved.
 *
 * Validated before it is stored, by the *same* two-step schema a boot uses — so a
 * document CI accepts is one the proxy will serve, and a broken one fails the
 * pipeline instead of landing in the database as the active revision.
 */
export async function importConfig(args: ImportConfigArgs): Promise<StoredConfig> {
  const logger = args.logger ?? createConsoleLogger("info");
  const document = await readDocument(args.file);
  const pool = await createPgPool(postgresUrl(args.env, "import-config"));
  const configStore = new PostgresConfigStore(pool, { logger });

  try {
    const keyring = await keyringFromEnv(args.env);
    const runtime: RuntimeContext = {
      env: args.env,
      fetch: (...call: Parameters<typeof fetch>) => fetch(...call),
      now: Date.now,
      waitUntil: () => {},
      log: logger,
    };
    // Storage is a *dependency* of a bundle, not something it validates, so an
    // in-memory adapter is enough to answer "would this configuration build?"
    // without a second connection pool.
    const holder = createBundleHolder({
      registry: containerRegistry(),
      storage: new MemoryStorageAdapter(),
      engine: new CelExpressionEngine(),
      runtime,
      logger,
      log: logger,
      ...(keyring === null
        ? {}
        : {
            // The real secret store, so `{"$secret": …}` references are resolved
            // against the database this configuration will actually run over.
            secrets: new EnvelopeSecretStore(new PostgresSecretRowStore(pool), keyring, {
              type: "postgres",
            }),
          }),
    });

    const check = await holder.validate(document);
    if (!check.ok) {
      throw new ConfigError(`${args.file} is not a usable configuration:\n${check.error}`);
    }

    const saved = await configStore.save(document, {
      createdBy: args.createdBy ?? "import-config",
      ...(args.note === undefined ? {} : { note: args.note }),
    });
    logger.info("imported configuration", { revision: saved.revision, file: args.file });
    return saved;
  } finally {
    await configStore.close();
    await pool.end?.();
  }
}
