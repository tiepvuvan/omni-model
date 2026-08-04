import { describe, expect, it, vi } from "vitest";
import { testJwks } from "../../src/auth/configuration-test.js";
import { silentLogger } from "../../src/logging.js";
import type { RuntimeContext } from "../../src/types.js";

function context(fetchImpl: typeof fetch): RuntimeContext {
  return {
    env: {},
    fetch: fetchImpl,
    now: () => Date.UTC(2026, 0, 1),
    waitUntil: () => {},
    log: silentLogger,
  };
}

describe("authentication configuration JWKS checks", () => {
  it("accepts a well-formed signing-key document", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ keys: [{ kid: "key-1", kty: "RSA" }] }),
    );

    expect(await testJwks("https://auth.example/jwks", context(fetchImpl), "Example Auth")).toEqual(
      {
        ok: true,
        message: "Example Auth is reachable and returned 1 signing key.",
      },
    );
    expect(fetchImpl).toHaveBeenCalledWith("https://auth.example/jwks", {
      headers: { accept: "application/json" },
    });
  });

  it("returns safe failures for network, HTTP, malformed, and empty responses", async () => {
    const checks: Array<[typeof fetch, Record<string, unknown>]> = [
      [
        vi.fn<typeof fetch>(async () => {
          throw new Error("secret network detail");
        }),
        { ok: false, message: "Example Auth could not be reached." },
      ],
      [
        vi.fn<typeof fetch>(async () => new Response("private upstream body", { status: 403 })),
        {
          ok: false,
          status: 403,
          message: "Example Auth rejected the configuration (HTTP 403).",
        },
      ],
      [
        vi.fn<typeof fetch>(async () => Response.json({ notKeys: [] })),
        { ok: false, message: "Example Auth returned an invalid signing-key document." },
      ],
      [
        vi.fn<typeof fetch>(async () => Response.json({ keys: [] })),
        { ok: false, message: "Example Auth returned no signing keys." },
      ],
    ];

    for (const [fetchImpl, expected] of checks) {
      const result = await testJwks(
        "https://auth.example/jwks",
        context(fetchImpl),
        "Example Auth",
      );
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain("secret network detail");
      expect(JSON.stringify(result)).not.toContain("private upstream body");
    }
  });

  it("allows an empty JWKS when the verifier supports a shared-secret fallback", async () => {
    const result = await testJwks(
      "https://auth.example/jwks",
      context(async () => Response.json({ keys: [] })),
      "Example Auth",
      { allowEmpty: true },
    );

    expect(result).toEqual({
      ok: true,
      message: "Example Auth is reachable and returned 0 signing keys.",
    });
  });
});
