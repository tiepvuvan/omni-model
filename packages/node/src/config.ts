import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ConfigError } from "@omni-model/core";

/** Arguments for {@link resolveConfigSource}. */
export interface ResolveConfigSourceArgs {
  /** Config file path from `--config` / `-c`, when given. */
  cliPath?: string;
  /** Process environment, consulted for `OMNI_CONFIG` and `OMNI_CONFIG_PATH`. */
  env: Record<string, string | undefined>;
  /** Directory that relative paths resolve against and where `omni.yaml` is searched. */
  cwd: string;
}

/** A resolved configuration document plus a human-readable description of its origin. */
export interface ConfigSource {
  /** Raw YAML text, ready for `parseConfig`. */
  yaml: string;
  /** Where the config came from (e.g. `--config foo.yaml`), for the startup log. */
  source: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readConfigFile(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read config file "${path}" (${label}): ${describeError(error)}`);
  }
}

/**
 * Locate the YAML configuration for the Node server. Sources are tried in
 * order and the first present one wins:
 *
 * 1. `cliPath` — the `--config` / `-c` command-line flag.
 * 2. `env.OMNI_CONFIG` — inline YAML in an environment variable.
 * 3. `env.OMNI_CONFIG_PATH` — an environment variable naming a YAML file.
 * 4. `<cwd>/omni.yaml` — a config file in the working directory.
 *
 * Throws `ConfigError` when no source is found or a named file is unreadable.
 */
export async function resolveConfigSource(args: ResolveConfigSourceArgs): Promise<ConfigSource> {
  const { cliPath, env, cwd } = args;

  if (cliPath !== undefined) {
    const path = resolve(cwd, cliPath);
    return { yaml: await readConfigFile(path, "--config"), source: `--config ${cliPath}` };
  }

  const inline = env.OMNI_CONFIG;
  if (inline !== undefined && inline !== "") {
    return { yaml: inline, source: "OMNI_CONFIG env" };
  }

  const envPath = env.OMNI_CONFIG_PATH;
  if (envPath !== undefined && envPath !== "") {
    const path = resolve(cwd, envPath);
    return {
      yaml: await readConfigFile(path, "OMNI_CONFIG_PATH"),
      source: `OMNI_CONFIG_PATH ${envPath}`,
    };
  }

  // Read-and-catch instead of exists-then-read so the file cannot vanish in between.
  const fallback = join(cwd, "omni.yaml");
  try {
    return { yaml: await readFile(fallback, "utf8"), source: fallback };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(`cannot read config file "${fallback}": ${describeError(error)}`);
    }
  }

  throw new ConfigError(
    "no configuration found; provide one via " +
      "(1) --config <path>, " +
      "(2) the OMNI_CONFIG environment variable with inline YAML, " +
      "(3) the OMNI_CONFIG_PATH environment variable naming a YAML file, or " +
      `(4) an omni.yaml file in the working directory (${cwd})`,
  );
}
