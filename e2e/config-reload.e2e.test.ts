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
 * Two instances, one database — the deployment shape this project is built for.
 *
 * Everything here is a claim the architecture makes and that only a real
 * multi-instance run can check: a configuration saved on one replica reaches the
 * other without a restart, a rejected one takes nobody down, and a request that
 * started under one configuration finishes under it even as the world changes
 * around it.
 *
 * Needs PostgreSQL, not an upstream: `TEST_POSTGRES_URL=… pnpm test:e2e`.
 */
const JWT_SECRET = "omni-e2e-reload-secret-not-a-real-credential";

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    server: { logLevel: "silent" },
    storage: { type: "postgres", url: "${OMNI_E2E_DATABASE_URL}" },
    security: { userAuth: { type: "jwt", secret: JWT_SECRET, algorithms: ["HS256"] } },
    routing: {
      rules: [
        {
          id: "main",
          when: "true",
          target: {
            type: "openai-compatible",
            baseUrl: "https://upstream.invalid/v1",
            apiKey: "sk-e2e",
            models: ["mock-model"],
          },
        },
      ],
    },
    ...overrides,
  };
}

describe.skipIf(!POSTGRES_URL)("E2E: two instances over one database", () => {
  let schema: ScopedSchema;
  let a: RunningServer;
  let b: RunningServer;
  let baseA: string;
  let baseB: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    schema = await createScopedSchema("omni_e2e_reload");
    env = { ...process.env, OMNI_E2E_DATABASE_URL: schema.url };
    const upstream = fakeUpstream();

    // A migrates on boot; B finds the schema already there, which is the rolling
    // deploy case.
    a = await startServer({
      config: config(),
      env,
      port: 0,
      hostname: "127.0.0.1",
      fetch: upstream.fetch,
    });
    b = await startServer({
      config: config(),
      env,
      port: 0,
      hostname: "127.0.0.1",
      fetch: upstream.fetch,
    });
    baseA = `http://127.0.0.1:${a.port}`;
    baseB = `http://127.0.0.1:${b.port}`;
  }, 60_000);

  afterAll(async () => {
    await a?.close({ drainTimeoutMs: 2000 });
    await b?.close({ drainTimeoutMs: 2000 });
    await schema?.drop();
  });

  const chat = (base: string, token: string, body: Record<string, unknown> = {}) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-omni-user-token": token },
      body: JSON.stringify({
        model: "mock-model",
        messages: [{ role: "user", content: "hello" }],
        ...body,
      }),
    });

  /**
   * Save a revision the way the admin API does: persist, then apply locally.
   *
   * The store deliberately does *not* reconfigure the instance that saved —
   * `save()` marks the revision as already seen so the saver's own watcher does
   * not re-announce it. Applying is a separate, explicit step, which is what
   * keeps the ordering validate → persist → apply honest.
   */
  const saveOn = async (
    instance: RunningServer,
    document: Record<string, unknown>,
    note: string,
  ): Promise<number> => {
    const saved = await instance.configStore.save(document, { createdBy: "e2e", note });
    const applied = await instance.holder.reload(saved.document, { revision: saved.revision });
    expect(applied.ok, `saving "${note}" should apply locally`).toBe(true);
    return saved.revision;
  };

  /** Wait for `instance` to be serving `revision`. */
  const adopts = (instance: RunningServer, revision: number, label: string) =>
    eventually(async () => (instance.holder.status().revision === revision ? true : null), {
      label,
      timeoutMs: 15_000,
    });

  it("both instances adopt the seeded revision", async () => {
    for (const base of [baseA, baseB]) {
      const ready = await fetch(`${base}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ status: "ready", revision: 1 });
    }
    // Seeded once, not twice: the second instance found the revision already
    // there rather than writing its own.
    const revisions = await schema.owner.query(
      `SELECT count(*)::int AS n FROM ${schema.name}.omni_config_revisions`,
    );
    expect(revisions.rows[0]?.n).toBe(1);
  });

  it("a revision saved on one instance reaches the other", async () => {
    const token = await signedToken(JWT_SECRET);
    expect((await chat(baseB, token)).status).toBe(200);

    // Restrict the models through A, exactly as the admin API would.
    const revision = await saveOn(
      a,
      config({
        routing: {
          allowedModels: ["only-this"],
          rules: [
            {
              id: "main",
              when: "true",
              target: {
                type: "openai-compatible",
                baseUrl: "https://upstream.invalid/v1",
                apiKey: "sk-e2e",
                models: ["mock-model"],
              },
            },
          ],
        },
      }),
      "restrict models",
    );
    expect(revision).toBe(2);

    // B was told nothing directly; it learns from the database.
    await adopts(b, revision, "instance B to adopt revision 2");
    expect((await chat(baseB, token)).status).toBe(404);
    expect((await chat(baseA, token)).status).toBe(404);

    const ready = await fetch(`${baseB}/readyz`);
    expect(await ready.json()).toMatchObject({ revision });
  }, 30_000);

  it("a rejected revision leaves both instances serving the previous one", async () => {
    const token = await signedToken(JWT_SECRET);
    const before = b.holder.status().revision;

    // Saved straight to the store, bypassing validation — which is exactly what
    // the admin API refuses to do, and therefore the only way a bad document is
    // already in the store when a replica reads it. Everything else is valid, so
    // the unknown provider is what fails rather than a missing verifier.
    const broken = config({
      routing: { rules: [{ id: "main", when: "true", target: { type: "no-such-provider" } }] },
    });
    const saved = await a.configStore.save(broken, {
      createdBy: "e2e",
      note: "deliberately broken",
    });

    await eventually(async () => (b.holder.status().lastError !== null ? true : null), {
      label: "instance B to reject the revision",
      timeoutMs: 15_000,
    });

    // Still serving, still on the old revision, and the reason is recorded.
    expect(b.holder.status().revision).toBe(before);
    expect(b.holder.status().lastError).toMatch(/routing\.rules\[0\]\.target/);
    expect(b.holder.status().configured).toBe(true);
    expect((await chat(baseB, token)).status).toBe(404);

    // Rolling forward past it works, so a bad revision is not a dead end.
    const recovered = await saveOn(a, config(), "recover");
    expect(recovered).toBe(saved.revision + 1);
    await adopts(b, recovered, "instance B to recover");
    expect((await chat(baseB, token)).status).toBe(200);
  }, 45_000);

  it("an in-flight stream finishes on the bundle it started with", async () => {
    // The reason configuration lives on an immutable bundle: a reload must be
    // invisible to a response already being written.
    const token = await signedToken(JWT_SECRET);
    const streaming = await chat(baseB, token, { stream: true });
    expect(streaming.status).toBe(200);

    await saveOn(
      a,
      config({
        routing: {
          allowedModels: ["something-else"],
          rules: [
            {
              id: "main",
              when: "true",
              target: {
                type: "openai-compatible",
                baseUrl: "https://upstream.invalid/v1",
                apiKey: "sk-e2e",
                models: ["mock-model"],
              },
            },
          ],
        },
      }),
      "swap mid-stream",
    );
    await eventually(
      async () => (b.holder.current()?.allowedModels.includes("something-else") ? true : null),
      { label: "instance B to swap bundles", timeoutMs: 15_000 },
    );

    // The stream started before the swap and still completes normally.
    const text = await streaming.text();
    expect(text).toContain("streamed");
    expect(text).toContain("[DONE]");
  }, 45_000);

  it("token-budget usage is shared, not per instance", async () => {
    // The reason usage lives in the database: two replicas must not each grant a
    // client the full token budget.
    const revision = await saveOn(
      a,
      config({
        rateLimits: [{ id: "shared", name: "shared", tokens: { limit: 14, window: "1m" } }],
      }),
      "tight shared limit",
    );
    await adopts(b, revision, "both instances on the rate-limited revision");

    const token = await signedToken(JWT_SECRET, "shared-budget-user");
    expect((await chat(baseA, token, { user: "initial-spend" })).status).toBe(200);
    // Usage is recorded after the response because its token cost is unknowable
    // beforehand. Vary the otherwise-ignored `user` field so cache hits cannot
    // hide real upstream usage. Once A observes exhaustion, B must see the same
    // stored total.
    let attempt = 0;
    await eventually(
      async () =>
        (await chat(baseA, token, { user: `budget-probe-${attempt++}` })).status === 429
          ? true
          : null,
      {
        label: "instance A to observe the spent token budget",
        timeoutMs: 15_000,
      },
    );
    expect((await chat(baseB, token, { user: "other-instance" })).status).toBe(429);
  }, 45_000);
});
