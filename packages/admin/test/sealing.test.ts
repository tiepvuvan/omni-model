import { isSecretRef } from "@omni-model/core";
import { describe, expect, it } from "vitest";
import { baseConfig, createTestAdmin, errorOf } from "./helpers.js";

const KEY = "sk-live-typed-straight-into-the-dashboard";

/** The stored (not applied) document, which is the one that must hold no secret. */
async function storedConfig(
  call: Awaited<ReturnType<typeof createTestAdmin>>["call"],
): Promise<Record<string, unknown>> {
  const body = (await (await call("/admin/api/config")).json()) as {
    config: Record<string, unknown>;
  };
  return body.config;
}

function targetOf(config: Record<string, unknown>): Record<string, unknown> {
  const routing = config.routing as { rules: { target: Record<string, unknown> }[] };
  return routing.rules[0]?.target as Record<string, unknown>;
}

/**
 * The dashboard types an API key into a routing rule. That is the whole point of
 * the routing redesign — credentials belong to the rule that uses them — and it
 * puts a plaintext credential in an HTTP body, so the save path is the boundary
 * where it stops being plaintext.
 */
describe("credentials typed into a rule are sealed before they are stored", () => {
  const withKey = (apiKey: unknown) =>
    baseConfig({
      routing: {
        rules: [{ id: "main", when: "true", target: { type: "openai", apiKey } }],
      },
    });

  it("replaces a plaintext key with a reference, and still serves", async () => {
    const { call, holder } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: withKey(KEY) }),
    });
    expect(response.status).toBe(200);

    // Stored: a reference, and the value appears nowhere in the document.
    const stored = await storedConfig(call);
    expect(isSecretRef(targetOf(stored).apiKey)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(KEY);

    // Applied: the live bundle resolved that reference back to the real key, so
    // the proxy can actually call the upstream.
    expect(holder.current()?.config.routing.rules[0]?.target).toMatchObject({ apiKey: KEY });
  });

  it("does not echo the sealed value in the save response", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: withKey(KEY) }),
    });
    expect(await response.text()).not.toContain(KEY);
  });

  it("passes an existing reference through rather than minting a second secret", async () => {
    // The dashboard reads a configuration back as references and re-sends them on
    // the next save. Sealing those again would create a row per save and leave the
    // old ones orphaned.
    const { call } = await createTestAdmin({ config: baseConfig() });
    await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: withKey(KEY) }),
    });

    // Two: the rule's apiKey and the jwt verifier's shared secret, both of which
    // arrived as plaintext in the same document.
    const first = (await (await call("/admin/api/secrets")).json()) as { secrets: unknown[] };
    expect(first.secrets).toHaveLength(2);

    // Read it back and save it unchanged, twice.
    const roundTripped = await storedConfig(call);
    await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: roundTripped }),
    });
    await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: roundTripped }),
    });

    const after = (await (await call("/admin/api/secrets")).json()) as { secrets: unknown[] };
    expect(after.secrets).toHaveLength(2);
  });

  it("reuses the row when a key is edited, so references stay valid", async () => {
    const { call, holder } = await createTestAdmin({ config: baseConfig() });
    await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: withKey(KEY) }),
    });
    const firstRef = targetOf(await storedConfig(call)).apiKey as { $secret: string };

    await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: withKey("sk-live-rotated") }),
    });
    const secondRef = targetOf(await storedConfig(call)).apiKey as { $secret: string };

    // Same id: the secret is named after the path, and `put` reuses the row for a
    // name — which is what keeps any other configuration referencing it working.
    expect(secondRef.$secret).toBe(firstRef.$secret);
    const secrets = (await (await call("/admin/api/secrets")).json()) as { secrets: unknown[] };
    expect(secrets.secrets).toHaveLength(2);
    expect(holder.current()?.config.routing.rules[0]?.target).toMatchObject({
      apiKey: "sk-live-rotated",
    });
  });

  it("leaves a ${VAR} reference alone", async () => {
    // Resolved from the environment at build time and never in the database, so
    // sealing it would store the literal "${VAR}" as though it were a credential.
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: withKey("${UPSTREAM_KEY}") }),
    });
    // Rejected only because the variable is unset in this test's environment —
    // which is itself the proof it was passed through as a reference.
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/UPSTREAM_KEY/);

    // Only the jwt secret from the seed was sealed; the ${VAR} was passed through.
    const secrets = (await (await call("/admin/api/secrets")).json()) as {
      secrets: { name: string }[];
    };
    expect(secrets.secrets.map((secret) => secret.name)).toEqual([
      "config.security.userAuth.secret",
    ]);
  });

  it("seals a key sent through the per-rule endpoint too", async () => {
    // Not just PUT /config: the dashboard edits one rule at a time.
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/routing/rules/backup", {
      method: "PUT",
      body: JSON.stringify({
        value: { when: "true", target: { type: "anthropic", apiKey: KEY } },
      }),
    });
    expect(response.status).toBe(200);

    const stored = await storedConfig(call);
    expect(JSON.stringify(stored)).not.toContain(KEY);
    const rules = (stored.routing as { rules: { id: string; target: { apiKey: unknown } }[] })
      .rules;
    expect(isSecretRef(rules[1]?.target.apiKey)).toBe(true);
  });

  it("records which paths were sealed, and never the values", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const { call } = await createTestAdmin({
      config: baseConfig(),
      logger: {
        debug: () => {},
        info: (message, fields) => entries.push({ message, ...fields }),
        warn: () => {},
        error: () => {},
      },
    });
    await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: withKey(KEY) }),
    });

    const sealed = entries.find(
      (entry) => entry.message === "sealed credentials from an admin write",
    );
    expect(sealed).toBeDefined();
    expect(sealed?.paths).toEqual(["security.userAuth.secret", "routing.rules[0].target.apiKey"]);
    expect(sealed?.by).toBe("root@test");
    expect(JSON.stringify(entries)).not.toContain(KEY);
  });

  it("refuses rather than storing plaintext when there is no master key", async () => {
    // Silently writing it inline would break the guarantee that a revision dump,
    // an audit log or a rollback diff cannot leak a credential.
    const { call, configStore } = await createTestAdmin({
      config: baseConfig(),
      withSecrets: false,
    });
    const response = await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: withKey(KEY) }),
    });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe("secrets_unavailable");
    expect(error.message).toMatch(/OMNI_ENCRYPTION_KEY/);
    // Names the path, never the value.
    expect(error.message).toContain("routing.rules[0].target.apiKey");
    expect(error.message).not.toContain(KEY);

    expect((await configStore.history(10)).length).toBe(1);
  });

  it("still allows unrelated changes without a master key", async () => {
    // Regression: refusing on the mere *presence* of plaintext made an
    // environment-configured deployment unable to save anything at all, because
    // every block-level write reads the seeded document back. Only a write that
    // introduces new plaintext is refused.
    const { call, holder } = await createTestAdmin({ config: baseConfig(), withSecrets: false });
    const response = await call("/admin/api/logging", {
      method: "PUT",
      body: JSON.stringify({ value: { requests: false } }),
    });
    expect(response.status).toBe(200);
    expect(holder.current()?.logging.requests).toBe(false);
  });

  it("seals a verifier's shared secret as well as a provider key", async () => {
    // The credential field list is not provider-specific: `security.userAuth`
    // holds a jwt shared secret, and that is a credential too.
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/security", {
      method: "PUT",
      body: JSON.stringify({
        value: { userAuth: { type: "jwt", secret: "j".repeat(40), algorithms: ["HS256"] } },
      }),
    });
    expect(response.status).toBe(200);

    const stored = await storedConfig(call);
    expect(JSON.stringify(stored)).not.toContain("j".repeat(40));
    const providers = [(stored.security as { userAuth: { secret: unknown } }).userAuth];
    expect(isSecretRef(providers[0]?.secret)).toBe(true);
  });

  it("seals every credential used by the application-verification layer", async () => {
    const turnstileSecret = "turnstile-server-secret";
    const recaptchaApiKey = "recaptcha-server-api-key";
    const serviceAccountKey = JSON.stringify({
      type: "service_account",
      client_email: "runtime@example.test",
      private_key: "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n",
    });
    const { call } = await createTestAdmin({
      config: baseConfig(),
      getGoogleAccessToken: async () => "test-access-token",
    });
    const config = baseConfig({
      security: {
        userAuth: {
          type: "jwt",
          issuer: "https://issuer.test",
          audience: "test",
          secret: "s".repeat(32),
        },
        appAuth: {
          mode: "any",
          providers: [
            { type: "cloudflare-turnstile", secret: turnstileSecret },
            {
              type: "recaptcha-enterprise",
              projectId: "risk-project",
              siteKey: "site-key",
              apiKey: recaptchaApiKey,
              expectedAction: "chat",
              minScore: 0.5,
            },
            {
              type: "google-play-integrity",
              packageName: "com.example.app",
              serviceAccountKey,
            },
          ],
        },
      },
    });

    const response = await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config }),
    });
    expect(response.status).toBe(200);

    const stored = await storedConfig(call);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(turnstileSecret);
    expect(serialized).not.toContain(recaptchaApiKey);
    expect(serialized).not.toContain("runtime@example.test");
    const providers = (
      stored.security as {
        appAuth: { providers: Array<Record<string, unknown>> };
      }
    ).appAuth.providers;
    expect(isSecretRef(providers[0]?.secret)).toBe(true);
    expect(isSecretRef(providers[1]?.apiKey)).toBe(true);
    expect(isSecretRef(providers[2]?.serviceAccountKey)).toBe(true);
  });
});
