import { type RunningServer, startServer } from "@omni-model/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createScopedSchema,
  eventually,
  fakeUpstream,
  POSTGRES_URL,
  type ScopedSchema,
  signedToken,
} from "./support/postgres.js";

/**
 * The operator journey, over HTTP, from an empty database.
 *
 * Sign up the first operator, configure the proxy from nothing, mint a client
 * key, make a real request through it, and find that request in the logs with its
 * token counts. Every step is the one an operator actually performs, in order,
 * against a real server and a real database — so this is what catches a surface
 * that works endpoint by endpoint but not as a sequence.
 *
 * Needs PostgreSQL, not an upstream: `TEST_POSTGRES_URL=… pnpm test:e2e`.
 */
const ADMIN_SECRET = "omni-e2e-admin-session-secret-not-a-real-credential";
const OPERATOR = { email: "ops@e2e.local", password: "a long e2e passphrase" };
const JWT_SECRET = "omni-e2e-user-token-secret-not-a-real-credential";
const ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");

describe.skipIf(!POSTGRES_URL)("E2E: the admin API from an empty database", () => {
  let schema: ScopedSchema;
  let server: RunningServer;
  let base: string;
  let upstream: ReturnType<typeof fakeUpstream>;
  /** Session cookie, carried between steps like a browser would. */
  let cookie = "";
  /** Threaded between steps: the journey is ordered on purpose. */
  let mintedSecret = "";
  let requestId = "";

  beforeAll(async () => {
    schema = await createScopedSchema("omni_e2e_admin");
    upstream = fakeUpstream();
    server = await startServer({
      // No config at all: the proxy boots closed and is configured over HTTP,
      // which is the flow this suite exists to prove.
      env: {
        ...process.env,
        OMNI_STORAGE_TYPE: "postgres",
        OMNI_STORAGE_POSTGRES_URL: schema.url,
        OMNI_ENCRYPTION_KEY: ENCRYPTION_KEY,
        OMNI_ADMIN_SECRET: ADMIN_SECRET,
        OMNI_LOG_LEVEL: "silent",
      },
      port: 0,
      hostname: "127.0.0.1",
      fetch: upstream.fetch,
    });
    base = `http://127.0.0.1:${server.port}`;
  }, 60_000);

  afterAll(async () => {
    await server?.close({ drainTimeoutMs: 2000 });
    await schema?.drop();
  });

  /** Request with the session cookie, capturing any the server sets. */
  async function admin(
    path: string,
    init: RequestInit & { anonymous?: boolean } = {},
  ): Promise<Response> {
    const { anonymous = false, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (!anonymous && cookie !== "") headers.set("cookie", cookie);
    if (rest.body !== undefined) headers.set("content-type", "application/json");
    const response = await fetch(`${base}${path}`, { ...rest, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) cookie = setCookie.split(";")[0] ?? "";
    return response;
  }

  const chat = (headers: Record<string, string>, body: Record<string, unknown> = {}) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        model: "mock-model",
        messages: [{ role: "user", content: "what is the answer" }],
        ...body,
      }),
    });

  it("boots closed: /v1 refuses, /readyz explains, /admin needs a session", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ status: "not_configured" });

    const refused = await chat({});
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { code: "not_configured" } });

    expect((await admin("/admin/api/config", { anonymous: true })).status).toBe(401);
  });

  it("step 1: the first operator signs up and can immediately use the API", async () => {
    const setup = await admin("/admin/api/setup", { anonymous: true });
    expect(await setup.json()).toMatchObject({ needsFirstOperator: true, operators: 0 });

    const signUp = await admin("/admin/api/auth/sign-up/email", {
      method: "POST",
      anonymous: true,
      body: JSON.stringify({ ...OPERATOR, name: "Ops" }),
    });
    expect(signUp.status).toBe(200);

    const me = await admin("/admin/api/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ actor: { email: OPERATOR.email, role: "admin" } });

    // And the gate closes behind them.
    const second = await admin("/admin/api/auth/sign-up/email", {
      method: "POST",
      anonymous: true,
      body: JSON.stringify({ email: "intruder@e2e.local", password: "another passphrase" }),
    });
    expect(second.status).toBe(403);
  }, 30_000);

  it("step 1b: an email-bound invite creates a second usable operator", async () => {
    const operatorCookie = cookie;
    const invited = { email: "teammate@e2e.local", password: "another long e2e passphrase" };
    const created = await admin("/admin/api/users/invites", {
      method: "POST",
      body: JSON.stringify({ email: invited.email }),
    });
    expect(created.status).toBe(201);
    const { link } = (await created.json()) as { link: string };
    const token = new URL(link).searchParams.get("token");
    expect(token).not.toBeNull();

    const stored = await schema.owner.query(
      `SELECT token_hash FROM ${schema.name}.omni_admin_invites`,
    );
    expect(String(stored.rows[0]?.token_hash)).not.toBe(token);
    expect(String(stored.rows[0]?.token_hash)).toMatch(/^[a-f0-9]{64}$/);

    const accepted = await admin(`/admin/api/invites/${token}/accept`, {
      method: "POST",
      anonymous: true,
      body: JSON.stringify({ name: "Team Mate", password: invited.password }),
    });
    expect(accepted.status).toBe(200);
    expect((await admin(`/admin/api/invites/${token}`, { anonymous: true })).status).toBe(404);

    const signIn = await admin("/admin/api/auth/sign-in/email", {
      method: "POST",
      anonymous: true,
      body: JSON.stringify(invited),
    });
    expect(signIn.status).toBe(200);
    expect(await (await admin("/admin/api/me")).json()).toMatchObject({
      actor: { email: invited.email, role: "admin" },
    });

    // Continue the operator journey as the original account.
    cookie = operatorCookie;
  }, 30_000);

  it("step 2: the upstream credential is stored encrypted, never readable", async () => {
    const stored = await admin("/admin/api/secrets", {
      method: "PUT",
      body: JSON.stringify({ name: "upstream", value: "sk-e2e-upstream-credential" }),
    });
    expect(stored.status).toBe(200);
    const { secret } = (await stored.json()) as { secret: { id: string; keyId: string } };
    expect(secret.keyId).toMatch(/^[0-9a-f]{12}$/);

    // Not readable back, and not in the database in the clear.
    expect((await admin(`/admin/api/secrets/${secret.id}/value`)).status).toBe(400);
    const rows = await schema.owner.query(`SELECT jwe FROM ${schema.name}.omni_secrets`);
    expect(String(rows.rows[0]?.jwe)).not.toContain("sk-e2e-upstream-credential");
    expect(String(rows.rows[0]?.jwe).split(".")).toHaveLength(5);
  });

  it("step 3: the proxy is configured from nothing and becomes ready", async () => {
    const secrets = (await (await admin("/admin/api/secrets")).json()) as {
      secrets: { id: string }[];
    };
    const secretId = secrets.secrets[0]?.id as string;

    const saved = await admin("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        note: "initial setup",
        config: {
          version: 1,
          server: { logLevel: "silent", maxInputTokens: 128 },
          storage: { type: "postgres", url: "${OMNI_STORAGE_POSTGRES_URL}" },
          security: {
            requireWriteKey: true,
            userAuth: { type: "jwt", secret: JWT_SECRET, algorithms: ["HS256"] },
          },
          routing: {
            rules: [
              {
                id: "main",
                when: "true",
                target: {
                  type: "deepseek",
                  baseUrl: "https://upstream.invalid/v1",
                  apiKey: { $secret: secretId },
                  models: ["mock-model"],
                },
              },
            ],
          },
          logging: { requests: true, content: true },
        },
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ revision: 1, createdBy: OPERATOR.email });

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: "ready", revision: 1 });

    // The stored revision keeps the reference; only the live bundle has the value.
    const stored = await schema.owner.query(
      `SELECT document::text AS doc FROM ${schema.name}.omni_config_revisions WHERE is_active`,
    );
    expect(String(stored.rows[0]?.doc)).toContain("$secret");
    expect(String(stored.rows[0]?.doc)).not.toContain("sk-e2e-upstream-credential");
  }, 30_000);

  it("step 4: the live provider probes green through the decrypted credential", async () => {
    const probe = await admin("/admin/api/routing/rules/main/test", { method: "POST" });
    expect(probe.status).toBe(200);
    expect(await probe.json()).toMatchObject({ ok: true, status: 200 });
  });

  it("step 5: a write key is minted, and its plaintext is returned once", async () => {
    const created = await admin("/admin/api/write-keys", {
      method: "POST",
      body: JSON.stringify({ name: "ios app", allowedModels: ["mock-model"] }),
    });
    expect(created.status).toBe(201);
    const { writeKey, secret } = (await created.json()) as {
      writeKey: { id: string };
      secret: string;
    };
    expect(secret).toMatch(/^omk_/);
    mintedSecret = secret;

    // Only the hash is stored, so a database dump cannot be replayed.
    const rows = await schema.owner.query(
      `SELECT key_hash FROM ${schema.name}.omni_write_keys WHERE id = $1`,
      [writeKey.id],
    );
    expect(String(rows.rows[0]?.key_hash)).not.toBe(secret);

    // And the listing never hands it back.
    const listed = await (await admin("/admin/api/write-keys")).text();
    expect(listed).not.toContain(secret);
  });

  it("step 6: a real request needs both a client key and a user token", async () => {
    const keys = (await (await admin("/admin/api/write-keys")).json()) as {
      writeKeys: { name: string }[];
    };
    expect(keys.writeKeys.map((key) => key.name)).toEqual(["ios app"]);

    const token = await signedToken(JWT_SECRET);
    const secret = mintedSecret;

    // Each axis alone is refused: "which app" and "which user" are separate.
    expect((await chat({ "x-omni-user-token": token })).status).toBe(401);
    expect((await chat({ authorization: `Bearer ${secret}` })).status).toBe(401);

    const answered = await chat({
      authorization: `Bearer ${secret}`,
      "x-omni-user-token": token,
    });
    expect(answered.status).toBe(200);
    expect(answered.headers.get("x-omni-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const body = (await answered.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toContain("fake upstream");
    requestId = answered.headers.get("x-omni-request-id") ?? "";

    const oversized = await chat(
      { authorization: `Bearer ${secret}`, "x-omni-user-token": token },
      { messages: [{ role: "user", content: "x".repeat(1000) }] },
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      error: { code: "input_token_limit_exceeded" },
    });
  }, 30_000);

  it("step 7: the request is in the logs, attributed and costed", async () => {
    const log = await eventually(
      async () => {
        const response = await admin(`/admin/api/logs/${requestId}?includeContent=true`);
        if (response.status !== 200) return null;
        return (await response.json()) as {
          log: Record<string, unknown> & { content?: Record<string, unknown> };
        };
      },
      { label: "the request to appear in the logs", timeoutMs: 10_000 },
    );

    expect(log.log).toMatchObject({
      status: 200,
      modelRequested: "mock-model",
      // The provider *type*, not a rule id: a log row wants to say "this went to
      // an OpenAI-compatible upstream". Which rule matched is `routeName`.
      providerId: "deepseek",
      routeName: "main",
      userId: "user-e2e",
      writeKeyName: "ios app",
      totalTokens: 14,
    });
    expect(log.log.writeKeyId).not.toBeNull();
    // Content capture was switched on in the configuration, so the prompt is here.
    expect(JSON.stringify(log.log.content)).toContain("what is the answer");
    expect(log.log.content).toMatchObject({
      headers: {
        authorization: "[REDACTED]",
        "x-omni-user-token": "[REDACTED]",
      },
      body: {
        model: "mock-model",
        messages: [{ role: "user", content: "what is the answer" }],
      },
    });

    const usage = await admin("/admin/api/usage/summary?hours=1");
    const summary = (await usage.json()) as { clients: { writeKeyName: string | null }[] };
    expect(summary.clients.map((client) => client.writeKeyName)).toContain("ios app");

    const listed = (await (await admin("/admin/api/write-keys")).json()) as {
      writeKeys: {
        name: string;
        usage: { totalTokens: number; lastUsedAt: number | null; lastModel: string | null };
      }[];
    };
    expect(listed.writeKeys[0]).toMatchObject({
      name: "ios app",
      usage: { totalTokens: 14, lastModel: "mock-model" },
    });
    expect(listed.writeKeys[0]?.usage.lastUsedAt).not.toBeNull();
  }, 30_000);

  it("step 8: revoking the key stops that client without touching users", async () => {
    const keys = (await (await admin("/admin/api/write-keys")).json()) as {
      writeKeys: { id: string }[];
    };
    const id = keys.writeKeys[0]?.id as string;
    expect((await admin(`/admin/api/write-keys/${id}`, { method: "DELETE" })).status).toBe(200);

    const token = await signedToken(JWT_SECRET);
    // Each replica caches key lookups briefly, so revocation is eventual here.
    await eventually(
      async () => {
        const response = await chat({
          authorization: `Bearer ${mintedSecret}`,
          "x-omni-user-token": token,
        });
        return response.status === 401 ? true : null;
      },
      { label: "the revoked key to be refused", timeoutMs: 20_000 },
    );

    // The row survives revocation, so past usage stays attributable.
    const rows = await schema.owner.query(
      `SELECT disabled_at FROM ${schema.name}.omni_write_keys WHERE id = $1`,
      [id],
    );
    expect(rows.rows[0]?.disabled_at).not.toBeNull();
  }, 45_000);

  it("step 9: history is append-only and a rollback is a new revision", async () => {
    await admin("/admin/api/logging", {
      method: "PUT",
      body: JSON.stringify({ value: { requests: true, content: false } }),
    });
    const rolled = await admin("/admin/api/config/revisions/1/rollback", { method: "POST" });
    expect(rolled.status).toBe(200);
    expect(await rolled.json()).toMatchObject({ revision: 3, note: "rollback to revision 1" });

    const history = (await (await admin("/admin/api/config/revisions")).json()) as {
      revisions: { revision: number; active: boolean }[];
    };
    expect(history.revisions.map((entry) => entry.revision)).toEqual([3, 2, 1]);
    expect(history.revisions[0]?.active).toBe(true);
  }, 30_000);
});
