import type { ComponentDescriptor } from "./api";

/**
 * Which component type a new form should start on.
 *
 * `GET /admin/api/meta` returns types sorted alphabetically, which makes the
 * default arbitrary — `apple-app-attest` for verifiers, and `anthropic` for
 * providers. Neither is the type most operators want first, and the verifier one
 * actively contradicts the empty state, which recommends `jwt` as the option that
 * needs no external service.
 *
 * Falls back to the first available type, so a registry without the preferred
 * type still produces a working form.
 */
export function preferredType(
  available: readonly ComponentDescriptor[],
  preferred: readonly string[],
): string {
  for (const type of preferred) {
    if (available.some((entry) => entry.type === type)) return type;
  }
  return available[0]?.type ?? "";
}

/** `jwt` needs no external service, which is what makes it the right first form. */
export const PREFERRED_VERIFIERS = ["jwt"] as const;

/**
 * `openai-compatible` first: it is the one that works against anything with an
 * OpenAI-shaped endpoint, including a local model server.
 */
export const PREFERRED_PROVIDERS = ["openai-compatible", "openai"] as const;
