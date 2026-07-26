import { CREDENTIAL_FIELDS as CORE_CREDENTIAL_FIELDS } from "@omni-model/core";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_FIELDS, isEnvRef, isSecretRef } from "../src/components/schema-form";

/**
 * The dashboard's copy of the credential field list must match core's.
 *
 * It is duplicated rather than imported because importing `@omni-model/core`
 * into the browser bundle would pull in hono, zod, jose and the CEL engine for
 * the sake of one array. Duplication is only safe if drift is impossible, which
 * is what this test is for — the failure mode it prevents is a field core learns
 * to seal that the dashboard keeps rendering as an ordinary text input, showing
 * a credential in the clear.
 */
describe("credential fields", () => {
  it("matches core exactly", () => {
    expect([...CREDENTIAL_FIELDS].sort()).toEqual([...CORE_CREDENTIAL_FIELDS].sort());
  });
});

describe("reference detection", () => {
  it("recognises a sealed secret", () => {
    expect(isSecretRef({ $secret: "abc" })).toBe(true);
    expect(isSecretRef({ $secret: 1 })).toBe(false);
    expect(isSecretRef("sk-plaintext")).toBe(false);
    expect(isSecretRef(null)).toBe(false);
  });

  it("recognises an environment reference without matching a value containing one", () => {
    expect(isEnvRef("${OPENAI_API_KEY}")).toBe(true);
    expect(isEnvRef("${A_1}")).toBe(true);
    // Anchored on purpose: `sk-${X}` is a plaintext credential with interpolation
    // in it, and treating it as a reference would show it as "safe" and then keep
    // it out of the seal path.
    expect(isEnvRef("sk-${OPENAI_API_KEY}")).toBe(false);
    expect(isEnvRef("${1BAD}")).toBe(false);
    expect(isEnvRef("plain")).toBe(false);
  });
});
