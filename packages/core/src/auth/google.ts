import { ConfigError } from "../errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate explicit Google service-account JSON without exposing any field
 * values. ADC and Workload Identity Federation remain runtime concerns.
 */
export function validateGoogleServiceAccountKey(
  componentType: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigError(
      `invalid "${componentType}" verifier options: serviceAccountKey is not JSON`,
    );
  }
  if (
    !isRecord(parsed) ||
    parsed.type !== "service_account" ||
    typeof parsed.client_email !== "string" ||
    parsed.client_email === "" ||
    typeof parsed.private_key !== "string" ||
    parsed.private_key === ""
  ) {
    throw new ConfigError(
      `invalid "${componentType}" verifier options: serviceAccountKey must contain ` +
        "type=service_account, client_email and private_key",
    );
  }
  return value;
}
