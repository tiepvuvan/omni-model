import { describe, expect, it } from "vitest";
import { helpFor, helpKeys } from "../src/lib/help";
import { PROVIDER_SCHEMAS, VERIFIER_SCHEMAS } from "./support/fake-api";

/**
 * Every field an operator can see has to say what it is for.
 *
 * The schemas carry `description` on some fields and nothing on others, and where
 * they do it is written for a contributor reading the source. Without this test the
 * copy is advisory: a verifier gains an option, the generated form renders it, and
 * it ships with a blank hint that nobody notices because the form still works.
 */
const ALL = [...VERIFIER_SCHEMAS, ...PROVIDER_SCHEMAS];

describe("field help", () => {
  it("covers every option of every registered component", () => {
    const missing: string[] = [];
    for (const component of ALL) {
      const properties = component.optionsSchema.properties ?? {};
      for (const [field, schema] of Object.entries(properties)) {
        // `type` is the discriminator and `name` is a label the UI owns.
        if (field === "type" || field === "name") continue;
        const description = (schema as { description?: string }).description;
        if (helpFor(component.type, field, description) === undefined) {
          missing.push(`${component.type}.${field}`);
        }
      }
    }

    expect(missing, "these fields would render with no explanation").toEqual([]);
  });

  it("prefers operator-facing copy over the schema's own description", () => {
    // The schema says "Consume limited-use tokens through Firebase to prevent
    // replay", which does not tell an operator it costs a round trip per request
    // and needs Admin credentials in the container.
    const help = helpFor("firebase-app-check", "consume", "Consume limited-use tokens");

    expect(help).toContain("round trip");
    expect(help).not.toBe("Consume limited-use tokens");
  });

  it("falls back to the schema description for a field it has no copy for", () => {
    expect(helpFor("some-embedder-provider", "wobble", "A wobble factor")).toBe("A wobble factor");
  });

  it("returns nothing when there is neither, so the caller can omit the line", () => {
    expect(helpFor("some-embedder-provider", "wobble")).toBeUndefined();
  });

  it("says a credential is sealed and unreadable wherever one appears", () => {
    // The single most important thing to tell someone typing into these boxes.
    for (const [type, field] of [
      ["openai", "apiKey"],
      ["jwt", "secret"],
      ["apple-device-check", "privateKey"],
      ["supabase", "jwtSecret"],
    ] as const) {
      expect(helpFor(type, field), `${type}.${field}`).toMatch(/seal/i);
    }
  });

  it("has no copy for a field no component has", () => {
    // A stale key is dead copy that reads as coverage.
    const known = new Set<string>();
    for (const component of ALL) {
      for (const field of Object.keys(component.optionsSchema.properties ?? {})) {
        known.add(`${component.type}.${field}`);
        known.add(`*.${field}`);
      }
    }
    // Two wildcards cover fields the *screens* own rather than the schemas: a
    // rule's `model`, which the target card renders itself, and `name`, which the
    // UI supplies as a label. Neither appears in a schema's properties.
    const uiOwned = new Set(["*.model", "*.name"]);
    // Fields belonging to components the fake registry does not model are allowed;
    // this only checks the wildcard entries, which apply to everything.
    const staleWildcards = helpKeys()
      .filter((key) => key.startsWith("*.") && !uiOwned.has(key))
      .filter((key) => !known.has(key));

    expect(staleWildcards).toEqual([]);
  });
});
