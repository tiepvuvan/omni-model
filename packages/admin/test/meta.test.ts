import { describe, expect, it } from "vitest";
import { baseConfig, createTestAdmin, errorOf } from "./helpers.js";

interface Meta {
  providers: Array<{ type: string; optionsSchema: unknown }>;
  authVerifiers: Array<{ type: string; optionsSchema: unknown }>;
  storage: Array<{ type: string; optionsSchema: unknown }>;
  configSchema: unknown;
  secretsAvailable: boolean;
  logsAvailable: boolean;
}

describe("component metadata", () => {
  it("publishes every registered type with a usable JSON Schema", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const meta = (await (await call("/admin/api/meta")).json()) as Meta;

    expect(meta.providers.map((p) => p.type)).toEqual([
      "anthropic",
      "google",
      "openai",
      "openai-compatible",
    ]);
    // Every built-in auth mode, including the three server-verified app proofs.
    expect(meta.authVerifiers.map((v) => v.type)).toEqual(
      expect.arrayContaining([
        "apple-app-attest",
        "apple-device-check",
        "aws-cognito",
        "clerk",
        "cloudflare-turnstile",
        "firebase-app-check",
        "firebase-auth",
        "google-play-integrity",
        "jwt",
        "recaptcha-enterprise",
        "supabase",
      ]),
    );

    // A dashboard renders forms from these, so an unrepresentable schema is a
    // silently blank form rather than an error — assert they are all there.
    for (const component of [...meta.providers, ...meta.authVerifiers, ...meta.storage]) {
      expect(component.optionsSchema, `${component.type} publishes no schema`).not.toBeNull();
      expect(component.optionsSchema).toHaveProperty("properties");
    }
  });

  it("names the fields a provider form has to render", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const meta = (await (await call("/admin/api/meta")).json()) as Meta;
    const openai = meta.providers.find((p) => p.type === "openai");
    expect(openai).toBeDefined();
    const { properties } = (openai as { optionsSchema: { properties: Record<string, unknown> } })
      .optionsSchema;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["apiKey", "baseUrl", "models"]),
    );
  });

  it("says whether secrets and logs are usable in this deployment", async () => {
    const withBoth = await createTestAdmin({ config: baseConfig() });
    const meta = (await (await withBoth.call("/admin/api/meta")).json()) as Meta;
    expect(meta.secretsAvailable).toBe(true);
    expect(meta.logsAvailable).toBe(true);

    const noSecrets = await createTestAdmin({ config: baseConfig(), withSecrets: false });
    const without = (await (await noSecrets.call("/admin/api/meta")).json()) as Meta;
    expect(without.secretsAvailable).toBe(false);
  });
});

describe("routing simulation", () => {
  /** Two routes: one that only fires for a named client, one catch-all. */
  const routed = baseConfig({
    routing: {
      rules: [
        {
          id: "premium-clients",
          when: 'client.name == "ios app"',
          target: { type: "openai", apiKey: "sk-b", baseUrl: "https://b.test/v1" },
        },
        {
          id: "everything-else",
          when: "true",
          target: { type: "openai", apiKey: "sk-a", baseUrl: "https://a.test/v1" },
        },
      ],
    },
  });

  it("shows which route a request would take", async () => {
    const { call } = await createTestAdmin({ config: routed });
    const response = await call("/admin/api/routing/simulate", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", clientName: "ios app" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { matched: boolean; route: string; provider: string };
    expect(body.matched).toBe(true);
    expect(body.route).toBe("premium-clients");
    expect(body.provider).toBe("openai");
  });

  it("falls through to the catch-all for a different client", async () => {
    const { call } = await createTestAdmin({ config: routed });
    const response = await call("/admin/api/routing/simulate", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", clientName: "android app" }),
    });
    const body = (await response.json()) as { route: string; provider: string };
    expect(body.route).toBe("everything-else");
    expect(body.provider).toBe("openai");
  });

  it("returns the facts the rules were evaluated against", async () => {
    const { call } = await createTestAdmin({ config: routed });
    const response = await call("/admin/api/routing/simulate", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4o",
        stream: true,
        messageCount: 3,
        userId: "user-1",
        claims: { plan: "pro" },
        clientName: "ios app",
      }),
    });
    const body = (await response.json()) as {
      facts: {
        request: { model: string; stream: boolean; messageCount: number };
        user: { id: string; claims: Record<string, unknown> };
        client: { name: string; authenticated: boolean };
      };
    };
    // The whole point of the endpoint: an operator can see what `when:` sees,
    // including that a missing claim is missing rather than empty.
    expect(body.facts.request).toMatchObject({ model: "gpt-4o", stream: true, messageCount: 3 });
    expect(body.facts.user.id).toBe("user-1");
    expect(body.facts.user.claims).toEqual({ plan: "pro" });
    expect(body.facts.client).toMatchObject({ name: "ios app", authenticated: true });
  });

  it("reports a model nothing would serve as an unmatched simulation, not an error", async () => {
    const { call } = await createTestAdmin({
      config: baseConfig({
        routing: {
          allowedModels: ["gpt-4o"],
          rules: [{ id: "default", when: "true", target: { type: "openai", apiKey: "sk" } }],
        },
      }),
    });
    const response = await call("/admin/api/routing/simulate", {
      method: "POST",
      body: JSON.stringify({ model: "not-allowed" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { matched: boolean; reason: string };
    expect(body.matched).toBe(false);
    expect(body.reason).toMatch(/not-allowed/);
  });

  it("reports a rule that throws, which the router silently skips", async () => {
    // CEL throws on a missing map key, so an unguarded claim read never fires.
    // The router treats that as "no match" — correct for serving traffic, and the
    // exact reason a broken rule is invisible in production.
    const { call } = await createTestAdmin({
      config: baseConfig({
        routing: {
          rules: [
            {
              id: "pro-only",
              when: 'user.claims.plan == "pro"',
              target: { type: "openai", apiKey: "sk" },
            },
            { id: "catch-all", when: "true", target: { type: "openai", apiKey: "sk" } },
          ],
        },
      }),
    });
    const response = await call("/admin/api/routing/simulate", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", userId: "u1" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      matched: boolean;
      route: string | null;
      rules: Array<{ rule: string; outcome: string; error?: string }>;
      warnings: string[];
    };
    // Served by the catch-all, so the request itself would succeed...
    expect(body.matched).toBe(true);
    expect(body.route).toBe("catch-all");
    // ...while the rule the operator wrote never fires, and they are told so.
    expect(body.rules).toEqual([
      expect.objectContaining({ rule: "pro-only", outcome: "error" }),
      expect.objectContaining({ rule: "catch-all", outcome: "match" }),
    ]);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatch(/never match/);
    expect(body.warnings[0]).toMatch(/has\(/);
  });

  it("reports a guarded rule as a plain no-match", async () => {
    const { call } = await createTestAdmin({
      config: baseConfig({
        routing: {
          rules: [
            {
              id: "pro-only",
              when: 'has(user.claims.plan) && user.claims.plan == "pro"',
              target: { type: "openai", apiKey: "sk" },
            },
            { id: "catch-all", when: "true", target: { type: "openai", apiKey: "sk" } },
          ],
        },
      }),
    });
    const response = await call("/admin/api/routing/simulate", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", userId: "u1" }),
    });
    const body = (await response.json()) as {
      rules: Array<{ outcome: string }>;
      warnings: string[];
    };
    expect(body.rules[0]?.outcome).toBe("no-match");
    expect(body.warnings).toEqual([]);
  });

  it("stops reporting rules after the one that matched", async () => {
    const { call } = await createTestAdmin({ config: routed });
    const response = await call("/admin/api/routing/simulate", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", clientName: "ios app" }),
    });
    const body = (await response.json()) as { rules: Array<{ rule: string; outcome: string }> };
    // The catch-all is never reached, so claiming anything about it would be a lie.
    expect(body.rules).toEqual([
      expect.objectContaining({ rule: "premium-clients", outcome: "match" }),
    ]);
  });

  it("503s when nothing is applied", async () => {
    const { call } = await createTestAdmin();
    const response = await call("/admin/api/routing/simulate", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o" }),
    });
    expect(response.status).toBe(503);
  });

  it("rejects a simulation with no model", async () => {
    const { call } = await createTestAdmin({ config: routed });
    const response = await call("/admin/api/routing/simulate", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("invalid_body");
  });
});
