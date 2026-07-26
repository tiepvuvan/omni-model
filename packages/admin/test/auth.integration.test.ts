import {
  CelExpressionEngine,
  createBundleHolder,
  createDefaultRegistry,
  MemoryConfigStore,
  MemoryStorageAdapter,
  MemoryWriteKeyStore,
  type RuntimeContext,
  silentLogger,
} from "@omni-model/core";
import type { PgPoolLike } from "@omni-model/postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdminApp, createAdminApp, createAdminUser, grantAdminRole } from "../src/index.js";
import { baseConfig } from "./helpers.js";

/**
 * Better Auth against a real PostgreSQL. Opt in with `TEST_POSTGRES_URL` or run
 * `pnpm test:pg`.
 *
 * The offline suites use an auth double, because a fake is the only way to assert
 * an authorization rule without a database. This is the other half: that the real
 * library actually creates its schema in our pool, that a session cookie reaches
 * our routes, and — the part no fake can prove — that the first-run flow ends with
 * an account that can *use* the admin API.
 */
const url = process.env.TEST_POSTGRES_URL;

if (process.env.OMNI_REQUIRE_PG === "1" && !url) {
  throw new Error("OMNI_REQUIRE_PG=1 but TEST_POSTGRES_URL is unset");
}

const SECRET = "a".repeat(32);
const PASSWORD = "correct horse battery staple";

describe.skipIf(!url)("admin auth (integration)", () => {
  /**
   * Its own **database**, not a schema in a shared one.
   *
   * Better Auth's migrator introspects with Kysely, which enumerates the whole
   * database and then queries what it found. Another suite dropping its schema in
   * between makes that second query fail with `schema … does not exist` — naming a
   * schema this suite has never heard of. A schema-scoped `search_path` does not
   * help, because the introspection is not scoped by it.
   */
  const database = `omni_admin_${process.pid.toString(36)}${Date.now().toString(36)}`;
  let cluster: Pool;
  let owner: Pool;
  let pool: PgPoolLike;
  let admin: AdminApp;

  /** Cookies from the most recent sign-up/sign-in, for the next request. */
  let cookie = "";

  const call = async (
    path: string,
    init: RequestInit & { authenticated?: boolean } = {},
  ): Promise<Response> => {
    const { authenticated = true, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (authenticated && cookie !== "") headers.set("cookie", cookie);
    if (rest.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await admin.app.request(`http://admin.test${path}`, { ...rest, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) cookie = setCookie.split(";")[0] ?? "";
    return response;
  };

  beforeAll(async () => {
    cluster = new Pool({ connectionString: url });
    await cluster.query(`CREATE DATABASE ${database}`);

    const scoped = new URL(url as string);
    scoped.pathname = `/${database}`;
    owner = new Pool({ connectionString: scoped.toString() });
    pool = new Pool({ connectionString: scoped.toString() }) as unknown as PgPoolLike;

    const runtime: RuntimeContext = {
      env: {},
      fetch: async () => new Response("{}"),
      now: Date.now,
      waitUntil: () => {},
      log: silentLogger,
    };
    const holder = createBundleHolder({
      registry: createDefaultRegistry(),
      storage: new MemoryStorageAdapter(),
      engine: new CelExpressionEngine(),
      runtime,
      logger: silentLogger,
      log: silentLogger,
    });
    await holder.reload(baseConfig(), { revision: 1 });

    admin = createAdminApp({
      pool,
      secret: SECRET,
      baseURL: "http://admin.test",
      holder,
      configStore: new MemoryConfigStore(),
      writeKeys: new MemoryWriteKeyStore(),
      secrets: null,
      registry: createDefaultRegistry(),
      runtime,
      logger: silentLogger,
    });
    await admin.migrate();
  }, 30_000);

  afterAll(async () => {
    // Every connection has to be closed before the database can be dropped.
    await (pool as unknown as Pool)?.end?.();
    await owner?.end();
    await cluster?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await cluster?.end();
  }, 30_000);

  it("creates its own tables in our pool", async () => {
    const result = await owner.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const tables = result.rows.map((row) => String(row.table_name));
    expect(tables).toEqual(expect.arrayContaining(["account", "session", "user", "verification"]));
  });

  it("reports that the deployment needs its first operator", async () => {
    const response = await call("/admin/api/setup", { authenticated: false });
    expect(await response.json()).toMatchObject({ needsFirstOperator: true, operators: 0 });
  });

  it("refuses every admin route before anyone signs up", async () => {
    const response = await call("/admin/api/config", { authenticated: false });
    expect(response.status).toBe(401);
  });

  it("signs up the first operator, and that account can immediately use the API", async () => {
    const signUp = await call("/admin/api/auth/sign-up/email", {
      method: "POST",
      authenticated: false,
      body: JSON.stringify({ email: "first@test.local", password: PASSWORD, name: "First" }),
    });
    expect(signUp.status).toBe(200);
    expect(cookie).not.toBe("");

    // The whole point: the plugin defaults a new account to `user`, which would
    // be 403ed everywhere. First-run has to end somewhere usable.
    const me = await call("/admin/api/me");
    expect(me.status).toBe(200);
    const body = (await me.json()) as { actor: { email: string; role: string } };
    expect(body.actor.email).toBe("first@test.local");
    expect(body.actor.role).toBe("admin");
  });

  it("closes sign-up once an operator exists", async () => {
    const response = await call("/admin/api/auth/sign-up/email", {
      method: "POST",
      authenticated: false,
      body: JSON.stringify({ email: "second@test.local", password: PASSWORD }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("signup_closed");
    // And nothing was created.
    const count = await owner.query('SELECT count(*)::int AS n FROM "user"');
    expect(count.rows[0]?.n).toBe(1);
  });

  it("signs out, and the session stops working", async () => {
    expect((await call("/admin/api/me")).status).toBe(200);
    const signOut = await call("/admin/api/auth/sign-out", { method: "POST", body: "{}" });
    expect(signOut.status).toBe(200);
    expect((await call("/admin/api/me")).status).toBe(401);
  });

  it("signs back in with the same credentials", async () => {
    const signIn = await call("/admin/api/auth/sign-in/email", {
      method: "POST",
      authenticated: false,
      body: JSON.stringify({ email: "first@test.local", password: PASSWORD }),
    });
    expect(signIn.status).toBe(200);
    expect((await call("/admin/api/me")).status).toBe(200);
  });

  it("rejects a wrong password without a usable session", async () => {
    const before = cookie;
    const signIn = await admin.app.request("http://admin.test/admin/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "first@test.local", password: "wrong" }),
    });
    expect(signIn.status).toBeGreaterThanOrEqual(400);
    cookie = before;
  });

  it("refuses a forged session cookie", async () => {
    const response = await admin.app.request("http://admin.test/admin/api/me", {
      headers: { cookie: "better-auth.session_token=not-a-real-token" },
    });
    expect(response.status).toBe(401);
  });

  it("creates an operator without HTTP, the way create-admin does", async () => {
    const created = await createAdminUser(admin.auth as never, {
      email: "cli@test.local",
      password: PASSWORD,
      name: "CLI",
    });
    expect(created.email).toBe("cli@test.local");

    // A fresh account is a plain user until it is promoted...
    const before = await owner.query('SELECT role FROM "user" WHERE email = $1', [
      "cli@test.local",
    ]);
    expect(before.rows[0]?.role).not.toBe("admin");

    expect(await grantAdminRole(pool, "cli@test.local")).toBe(true);
    const after = await owner.query('SELECT role FROM "user" WHERE email = $1', ["cli@test.local"]);
    expect(after.rows[0]?.role).toBe("admin");
  });

  it("reports nothing to promote for an unknown email", async () => {
    expect(await grantAdminRole(pool, "nobody@test.local")).toBe(false);
  });

  it("is idempotent about migrations", async () => {
    // A second container starting against the same database must not fail.
    await expect(admin.migrate()).resolves.toBeUndefined();
  });
});
