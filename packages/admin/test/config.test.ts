import { describe, expect, it } from "vitest";
import { baseConfig, createTestAdmin, errorOf } from "./helpers.js";

interface ConfigResponse {
  config: Record<string, unknown> | null;
  revision: number | null;
  createdBy: string | null;
  note: string | null;
  applied: boolean;
  appliedRevision: number | null;
  error: string | null;
}

describe("configuration read and write", () => {
  it("returns the stored document and what is applied", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const body = (await (await call("/admin/api/config")).json()) as ConfigResponse;
    expect(body.revision).toBe(1);
    expect(body.applied).toBe(true);
    expect(body.appliedRevision).toBe(1);
    expect(body.error).toBeNull();
  });

  it("saves a revision, applies it, and attributes it to the operator", async () => {
    const { call, holder } = await createTestAdmin({ config: baseConfig() });
    const next = baseConfig({
      routing: {
        allowedModels: ["gpt-4o"],
        rules: [{ id: "default", when: "true", target: { type: "openai", apiKey: "sk-test" } }],
      },
    });
    const response = await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: next, note: "restrict models" }),
    });
    expect(response.status).toBe(200);
    const saved = (await response.json()) as { revision: number; createdBy: string; note: string };
    expect(saved.revision).toBe(2);
    expect(saved.createdBy).toBe("root@test");
    expect(saved.note).toBe("restrict models");
    // Applied, not merely stored.
    expect(holder.current()?.allowedModels).toEqual(["gpt-4o"]);
    expect(holder.status().revision).toBe(2);
  });

  it("rejects an invalid document with the message startup would have printed", async () => {
    const { call, holder, configStore } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        config: baseConfig({
          routing: { rules: [{ id: "default", when: "true", target: { type: "nope" } }] },
        }),
      }),
    });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe("invalid_config");
    expect(error.message).toMatch(/routing\.rules\[0\]\.target/);
    expect(error.message).toMatch(/"nope"/);
    // The previous configuration is still live, and nothing was persisted.
    expect(holder.status().revision).toBe(1);
    expect((await configStore.history(10)).length).toBe(1);
  });

  it("validates without applying or persisting", async () => {
    const { call, holder, configStore } = await createTestAdmin({ config: baseConfig() });
    const good = await call("/admin/api/config/validate", {
      method: "POST",
      body: JSON.stringify({ config: baseConfig({ server: { maxBodyBytes: 1024 } }) }),
    });
    expect(await good.json()).toEqual({ valid: true });

    const bad = await call("/admin/api/config/validate", {
      method: "POST",
      body: JSON.stringify({ config: { providers: {} } }),
    });
    expect(bad.status).toBe(200);
    const body = (await bad.json()) as { valid: boolean; error: string };
    expect(body.valid).toBe(false);
    expect(body.error).not.toBe("");

    // Neither call changed anything.
    expect(holder.status().revision).toBe(1);
    expect(holder.status().lastError).toBeNull();
    expect((await configStore.history(10)).length).toBe(1);
  });

  it("does not record a dry-run rejection as the live error", async () => {
    const { call, holder } = await createTestAdmin({ config: baseConfig() });
    await call("/admin/api/config/validate", {
      method: "POST",
      body: JSON.stringify({ config: { nonsense: true } }),
    });
    // Regression: a failed validation used to overwrite the reason reported for
    // the *serving* configuration, so /readyz claimed a healthy proxy was broken.
    expect(holder.status()).toEqual({ configured: true, revision: 1, lastError: null });
  });
});

describe("block-level updates", () => {
  it("replaces one block and leaves the rest alone", async () => {
    const { call, holder } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/logging", {
      method: "PUT",
      body: JSON.stringify({ value: { requests: true, content: true, maxContentBytes: 4096 } }),
    });
    expect(response.status).toBe(200);
    expect(holder.current()?.logging.content).toBe(true);
    expect(holder.current()?.logging.maxContentBytes).toBe(4096);
    // Untouched.
    expect([...(holder.current()?.providers.keys() ?? [])]).toEqual(["default"]);
  });

  it("replaces the rate-limit list, applying it to the running limiter", async () => {
    // The dashboard's rate-limit screen is this one call: the list is ordered and
    // a rule can be removed, neither of which a per-rule endpoint could express.
    const { call, holder } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/rate-limits", {
      method: "PUT",
      body: JSON.stringify({
        value: [
          {
            id: "free-tier",
            when: 'has(user.claims.tier) && user.claims.tier == "free"',
            key: "user",
            tokens: { limit: 30_000, window: "30d" },
          },
          { id: "baseline", key: "user", requests: { limit: 30, window: "1h" } },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(holder.current()?.config.rateLimits.map((rule) => rule.id)).toEqual([
      "free-tier",
      "baseline",
    ]);
  });

  it("rejects a rate-limit rule with no budget, the way a boot would", async () => {
    const { call, holder } = await createTestAdmin({ config: baseConfig() });
    const before = holder.current()?.config.rateLimits;

    const response = await call("/admin/api/rate-limits", {
      method: "PUT",
      body: JSON.stringify({ value: [{ id: "pointless", key: "user" }] }),
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("`requests` or `tokens`");
    // Nothing applied: a rejected document leaves the previous one serving.
    expect(holder.current()?.config.rateLimits).toEqual(before);
  });

  it("accepts a rule identified only by id, which is all a dashboard has", async () => {
    const { call, holder } = await createTestAdmin({ config: baseConfig() });

    const response = await call("/admin/api/rate-limits", {
      method: "PUT",
      body: JSON.stringify({ value: [{ id: "limit-1", tokens: { limit: 1000, window: "1d" } }] }),
    });

    expect(response.status).toBe(200);
    // There is no field on the screen to type a name into, so the id is the name.
    expect(holder.current()?.config.rateLimits[0]?.name).toBeUndefined();
  });

  it("adds and removes a routing rule", async () => {
    const { call, holder } = await createTestAdmin({ config: baseConfig() });
    const added = await call("/admin/api/routing/rules/backup", {
      method: "PUT",
      body: JSON.stringify({
        value: {
          when: 'request.model.startsWith("claude-")',
          target: { type: "anthropic", apiKey: "sk-ant" },
        },
      }),
    });
    expect(added.status).toBe(200);
    // Appended, not prepended: order is meaning, and a new rule must not silently
    // take precedence over the ones already there.
    expect(holder.current()?.config.routing.rules.map((rule) => rule.id)).toEqual([
      "default",
      "backup",
    ]);

    const removed = await call("/admin/api/routing/rules/backup", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(holder.current()?.config.routing.rules.map((rule) => rule.id)).toEqual(["default"]);
  });

  it("replaces a rule in place, keeping its position", async () => {
    const { call, holder } = await createTestAdmin({ config: baseConfig() });
    await call("/admin/api/routing/rules/second", {
      method: "PUT",
      body: JSON.stringify({
        value: { when: "true", target: { type: "openai", apiKey: "sk-2" } },
      }),
    });
    await call("/admin/api/routing/rules/default", {
      method: "PUT",
      body: JSON.stringify({
        value: { when: "true", target: { type: "anthropic", apiKey: "sk-ant" } },
      }),
    });

    const rules = holder.current()?.config.routing.rules ?? [];
    expect(rules.map((rule) => rule.id)).toEqual(["default", "second"]);
    expect(rules[0]?.target.type).toBe("anthropic");
  });

  it("404s when removing a rule that does not exist", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    expect((await call("/admin/api/routing/rules/ghost", { method: "DELETE" })).status).toBe(404);
  });

  it("rejects a rule that is not an object", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/routing/rules/bad", {
      method: "PUT",
      body: JSON.stringify({ value: "not an object" }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects a rule whose target names an unknown provider", async () => {
    // Validated by the same two-step schema a boot uses, so the API refuses
    // exactly what startup would have refused.
    const { call, holder } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/routing/rules/broken", {
      method: "PUT",
      body: JSON.stringify({ value: { when: "true", target: { type: "no-such-provider" } } }),
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("invalid_config");
    expect(holder.current()?.config.routing.rules).toHaveLength(1);
  });
});

describe("revision history and rollback", () => {
  it("lists revisions newest first", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    await call("/admin/api/logging", {
      method: "PUT",
      body: JSON.stringify({ value: { requests: false } }),
    });
    const body = (await (await call("/admin/api/config/revisions")).json()) as {
      revisions: Array<{ revision: number; active: boolean }>;
    };
    expect(body.revisions.map((r) => r.revision)).toEqual([2, 1]);
    expect(body.revisions[0]?.active).toBe(true);
  });

  it("rolls back by appending a copy rather than rewriting history", async () => {
    const { call, holder, configStore } = await createTestAdmin({ config: baseConfig() });
    await call("/admin/api/routing", {
      method: "PUT",
      body: JSON.stringify({
        value: {
          allowedModels: ["only-this"],
          rules: [{ id: "default", when: "true", target: { type: "openai", apiKey: "sk-test" } }],
        },
      }),
    });
    expect(holder.current()?.allowedModels).toEqual(["only-this"]);

    const response = await call("/admin/api/config/revisions/1/rollback", { method: "POST" });
    expect(response.status).toBe(200);
    const saved = (await response.json()) as { revision: number; note: string };
    expect(saved.revision).toBe(3);
    expect(saved.note).toBe("rollback to revision 1");
    // Live again, and revision 2 is still on the record.
    expect(holder.current()?.allowedModels).toEqual([]);
    expect((await configStore.history(10)).map((r) => r.revision)).toEqual([3, 2, 1]);
  });

  it("404s for a revision that does not exist", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    expect((await call("/admin/api/config/revisions/99")).status).toBe(404);
    expect((await call("/admin/api/config/revisions/99/rollback", { method: "POST" })).status).toBe(
      404,
    );
  });

  it("400s on a non-numeric revision instead of guessing", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    expect((await call("/admin/api/config/revisions/latest")).status).toBe(400);
  });
});

describe("provider probe", () => {
  it("reports a reachable upstream", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/routing/rules/default/test", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 200 });
  });

  it("reports an unreachable upstream as a result, not an error", async () => {
    const { call } = await createTestAdmin({
      config: baseConfig(),
      fetch: async () => {
        throw new Error("ECONNREFUSED upstream.test");
      },
    });
    const response = await call("/admin/api/routing/rules/default/test", { method: "POST" });
    // 200: "the upstream is down" is a successful answer to "is it up".
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/ECONNREFUSED/);
  });

  it("reports a rejected API key rather than passing on the fallback list", async () => {
    // Regression: `listModels` answers with the *configured* model list on any
    // upstream failure, so a probe that trusted its return value called a
    // provider with a dead credential healthy — the single most likely
    // misconfiguration an operator uses this endpoint to find.
    const { call } = await createTestAdmin({
      config: baseConfig(),
      fetch: async () =>
        new Response('{"error":{"message":"invalid api key"}}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    const response = await call("/admin/api/routing/rules/default/test", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, status: 401 });
  });

  it("404s for a rule that is not configured", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    expect((await call("/admin/api/routing/rules/ghost/test", { method: "POST" })).status).toBe(
      404,
    );
  });

  it("503s when nothing is applied yet", async () => {
    const { call } = await createTestAdmin();
    expect((await call("/admin/api/routing/rules/default/test", { method: "POST" })).status).toBe(
      503,
    );
  });
});

describe("warnings about rules that can never fire", () => {
  it("warns when a rule is appended after a catch-all", async () => {
    // Found by using the API: `PUT /routing/rules/:id` appends, and the seeded
    // configuration ends in `when: "true"` — so the new rule was dead on arrival
    // and the proxy kept answering normally from the earlier one.
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/routing/rules/premium", {
      method: "PUT",
      body: JSON.stringify({
        value: {
          when: 'has(user.claims.tier) && user.claims.tier == "pro"',
          target: { type: "openai", apiKey: "sk-pro" },
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { warnings: string[] };
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatch(/"premium" can never match/);
    expect(body.warnings[0]).toMatch(/Move "premium" above it/);
  });

  it("says nothing when the catch-all is last", async () => {
    const { call } = await createTestAdmin({
      config: baseConfig({
        routing: {
          rules: [
            {
              id: "premium",
              when: 'has(user.claims.tier) && user.claims.tier == "pro"',
              target: { type: "openai", apiKey: "sk-pro" },
            },
            { id: "default", when: "true", target: { type: "openai", apiKey: "sk" } },
          ],
        },
      }),
    });
    const response = await call("/admin/api/logging", {
      method: "PUT",
      body: JSON.stringify({ value: { requests: true } }),
    });
    expect((await response.json()).warnings).toEqual([]);
  });
});
