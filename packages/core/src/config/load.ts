import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigError } from "../errors.js";
import { type OmniConfig, omniConfigSchema } from "./schema.js";

/**
 * `${VAR}` and `${VAR:-default}` references, resolved against platform env.
 * `$${VAR}` escapes to a literal `${VAR}`.
 */
const ENV_REFERENCE = /\$(\$)?\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function interpolateEnv(
  value: string,
  env: Record<string, string | undefined>,
  path: string,
): string {
  return value.replace(ENV_REFERENCE, (match, escaped, name, fallback) => {
    if (escaped !== undefined) return match.slice(1);
    const resolved = env[name as string];
    if (resolved !== undefined) return resolved;
    if (fallback !== undefined) return fallback as string;
    throw new ConfigError(
      `missing environment variable "${name}" referenced at ${path}; ` +
        `set it or provide a default with \${${name}:-default}`,
    );
  });
}

function interpolateDeep(
  node: unknown,
  env: Record<string, string | undefined>,
  path: string,
): unknown {
  if (typeof node === "string") return interpolateEnv(node, env, path);
  if (Array.isArray(node)) {
    return node.map((item, index) => interpolateDeep(item, env, `${path}[${index}]`));
  }
  if (node !== null && typeof node === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = interpolateDeep(value, env, `${path}.${key}`);
    }
    return result;
  }
  return node;
}

/**
 * Parse and validate a YAML configuration document. Environment references
 * are interpolated before validation, so secrets never need to live in the
 * config file itself.
 */
export function parseConfig(
  yamlSource: string,
  env: Record<string, string | undefined> = {},
): OmniConfig {
  let document: unknown;
  try {
    document = parseYaml(yamlSource);
  } catch (error) {
    throw new ConfigError(`invalid YAML: ${error instanceof Error ? error.message : error}`);
  }
  if (document === null || document === undefined) {
    throw new ConfigError("configuration is empty");
  }
  const interpolated = interpolateDeep(document, env, "$");
  const result = omniConfigSchema.safeParse(interpolated);
  if (!result.success) {
    throw new ConfigError(`invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
