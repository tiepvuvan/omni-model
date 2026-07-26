import { describe, expect, it } from "vitest";
import type { ComponentDescriptor } from "../src/lib/api";
import { PREFERRED_PROVIDERS, PREFERRED_VERIFIERS, preferredType } from "../src/lib/preferred";

const types = (...names: string[]): ComponentDescriptor[] =>
  names.map((type) => ({ type, optionsSchema: null }));

/**
 * `GET /meta` sorts types alphabetically, so without this the default form is
 * whatever happens to sort first. On a real registry that is `apple-app-attest`
 * for verifiers — an option needing an Apple team id, offered to someone who has
 * just been told on the same screen that `jwt` needs no external service.
 */
describe("preferredType", () => {
  it("picks the preferred type over the alphabetically first one", () => {
    const registry = types("apple-app-attest", "apple-device-check", "jwt", "supabase");

    expect(preferredType(registry, PREFERRED_VERIFIERS)).toBe("jwt");
  });

  it("honours the order of preferences", () => {
    expect(
      preferredType(types("anthropic", "openai", "openai-compatible"), PREFERRED_PROVIDERS),
    ).toBe("openai-compatible");
    // Second choice when the first is not registered.
    expect(preferredType(types("anthropic", "openai"), PREFERRED_PROVIDERS)).toBe("openai");
  });

  it("falls back to the first available type", () => {
    // An embedder can register a registry containing none of the built-ins; the
    // form still has to open on something.
    expect(preferredType(types("custom-thing"), PREFERRED_VERIFIERS)).toBe("custom-thing");
  });

  it("returns an empty string for an empty registry rather than throwing", () => {
    expect(preferredType([], PREFERRED_VERIFIERS)).toBe("");
  });
});
