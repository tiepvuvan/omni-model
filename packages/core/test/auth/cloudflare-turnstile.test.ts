import { describe, expect, it, vi } from "vitest";
import type { VerifyContext } from "../../src/auth/types.js";
import { cloudflareTurnstileVerifierFactory } from "../../src/auth/verifiers/cloudflare-turnstile.js";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import type { RuntimeContext } from "../../src/types.js";

function context(fetchImpl: typeof fetch): VerifyContext {
  return {
    env: {},
    fetch: fetchImpl,
    now: () => 1_750_000_000_000,
    waitUntil: () => {},
    log: silentLogger,
    storage: new MemoryStorageAdapter(),
    clientIp: "203.0.113.7",
    maxInputTokens: 1024,
  };
}

const runtime = (fetchImpl: typeof fetch): RuntimeContext => context(fetchImpl);

describe("cloudflareTurnstileVerifierFactory", () => {
  it("publishes an app-layer schema and rejects bad options without echoing the secret", () => {
    expect(cloudflareTurnstileVerifierFactory).toMatchObject({
      type: "cloudflare-turnstile",
      layer: "app",
    });
    expect(() =>
      cloudflareTurnstileVerifierFactory.create(
        { secret: "do-not-echo", unexpected: true },
        runtime(fetch),
      ),
    ).toThrow(ConfigError);
    try {
      cloudflareTurnstileVerifierFactory.create(
        { secret: "do-not-echo", unexpected: true },
        runtime(fetch),
      );
    } catch (error) {
      expect(String(error)).not.toContain("do-not-echo");
    }
  });

  it("returns null without its header and does not contact Cloudflare", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const verifier = cloudflareTurnstileVerifierFactory.create(
      { secret: "server-secret" },
      runtime(fetchImpl),
    );
    expect(
      await verifier.verify(new Request("https://proxy.test/v1/models"), context(fetchImpl)),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates server-side, forwards the trusted IP, and exposes only curated claims", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toEqual({ "content-type": "application/json" });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        secret: "server-secret",
        response: "fresh-token",
        remoteip: "203.0.113.7",
      });
      expect(body.idempotency_key).toEqual(expect.any(String));
      return Response.json({
        success: true,
        challenge_ts: "2026-07-27T00:00:00Z",
        hostname: "app.example.com",
        action: "chat",
        cdata: "must-not-be-exposed",
        metadata: { ephemeral_id: "must-not-be-exposed" },
      });
    });
    const verifier = cloudflareTurnstileVerifierFactory.create(
      {
        secret: "server-secret",
        action: "chat",
        hostnames: ["app.example.com"],
      },
      runtime(fetchImpl),
    );
    const result = await verifier.verify(
      new Request("https://proxy.test/v1/chat/completions", {
        headers: { "x-turnstile-token": "fresh-token" },
      }),
      context(fetchImpl),
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual({
      ok: true,
      identity: {
        provider: "cloudflare-turnstile",
        claims: {
          challengeTime: "2026-07-27T00:00:00Z",
          hostname: "app.example.com",
          action: "chat",
        },
      },
    });
  });

  it("retries a transient response once with the same idempotency key", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? new Response("temporary", { status: 503 })
        : Response.json({ success: true });
    });
    const verifier = cloudflareTurnstileVerifierFactory.create(
      { secret: "server-secret" },
      runtime(fetchImpl),
    );
    const result = await verifier.verify(
      new Request("https://proxy.test/v1/models", {
        headers: { "x-turnstile-token": "fresh-token" },
      }),
      context(fetchImpl),
    );
    expect(result?.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[0]?.idempotency_key).toBe(bodies[1]?.idempotency_key);
  });

  it.each([
    [{ success: false, "error-codes": ["timeout-or-duplicate"] }, 401],
    [{ success: false, "error-codes": ["invalid-input-secret"] }, 503],
    [{ success: false, "error-codes": ["internal-error"] }, 503],
  ])("maps a Siteverify verdict to the right failure class", async (body, status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body));
    const verifier = cloudflareTurnstileVerifierFactory.create(
      { secret: "server-secret" },
      runtime(fetchImpl),
    );
    const result = await verifier.verify(
      new Request("https://proxy.test/v1/models", {
        headers: { "x-turnstile-token": "fresh-token" },
      }),
      context(fetchImpl),
    );
    expect(result).toMatchObject({ ok: false });
    expect(result?.ok === false ? (result.status ?? 401) : 0).toBe(status);
  });

  it("enforces action and hostname after a successful Siteverify response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ success: true, hostname: "evil.example", action: "other" }),
    );
    const actionVerifier = cloudflareTurnstileVerifierFactory.create(
      { secret: "secret", action: "chat" },
      runtime(fetchImpl),
    );
    const request = new Request("https://proxy.test/v1/models", {
      headers: { "x-turnstile-token": "token" },
    });
    expect(await actionVerifier.verify(request, context(fetchImpl))).toMatchObject({
      ok: false,
      reason: "Turnstile action does not match",
    });

    const hostnameVerifier = cloudflareTurnstileVerifierFactory.create(
      { secret: "secret", hostnames: ["app.example.com"] },
      runtime(fetchImpl),
    );
    expect(await hostnameVerifier.verify(request, context(fetchImpl))).toMatchObject({
      ok: false,
      reason: "Turnstile hostname is not allowed",
    });
  });

  it("fails closed on network, HTTP, and malformed-response failures", async () => {
    const failures: (typeof fetch)[] = [
      vi.fn<typeof fetch>(async () => {
        throw new Error("offline");
      }),
      vi.fn<typeof fetch>(async () => new Response("bad", { status: 502 })),
      vi.fn<typeof fetch>(async () => Response.json({ notSuccess: true })),
    ];
    for (const fetchImpl of failures) {
      const verifier = cloudflareTurnstileVerifierFactory.create(
        { secret: "secret" },
        runtime(fetchImpl),
      );
      const result = await verifier.verify(
        new Request("https://proxy.test/v1/models", {
          headers: { "x-turnstile-token": "token" },
        }),
        context(fetchImpl),
      );
      expect(result).toEqual({
        ok: false,
        status: 503,
        reason: "Turnstile verification unavailable",
      });
    }
  });

  it("rejects an oversized token before making an upstream request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const verifier = cloudflareTurnstileVerifierFactory.create(
      { secret: "secret" },
      runtime(fetchImpl),
    );
    const result = await verifier.verify(
      new Request("https://proxy.test/v1/models", {
        headers: { "x-turnstile-token": "x".repeat(2049) },
      }),
      context(fetchImpl),
    );
    expect(result).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
