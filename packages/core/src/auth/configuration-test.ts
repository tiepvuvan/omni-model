import type { RuntimeContext } from "../types.js";
import type { AuthConfigurationTestResult } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fetch and validate a verifier's remote JSON Web Key Set.
 *
 * The response body is never included in the result: upstream error pages can
 * contain operational details that do not belong in an admin response.
 */
export async function testJwks(
  url: string,
  ctx: RuntimeContext,
  service: string,
  options: { allowEmpty?: boolean } = {},
): Promise<AuthConfigurationTestResult> {
  let response: Response;
  try {
    response = await ctx.fetch(url, { headers: { accept: "application/json" } });
  } catch {
    return { ok: false, message: `${service} could not be reached.` };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: `${service} rejected the configuration (HTTP ${response.status}).`,
    };
  }

  const body = await response.json().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body.keys)) {
    return { ok: false, message: `${service} returned an invalid signing-key document.` };
  }
  if (body.keys.length === 0 && options.allowEmpty !== true) {
    return { ok: false, message: `${service} returned no signing keys.` };
  }
  return {
    ok: true,
    message: `${service} is reachable and returned ${body.keys.length} signing key${
      body.keys.length === 1 ? "" : "s"
    }.`,
  };
}
