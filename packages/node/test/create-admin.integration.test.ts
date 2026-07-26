import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFirstOperator } from "../src/create-admin.js";

/**
 * The `create-admin` command against a real PostgreSQL. Opt in with
 * `TEST_POSTGRES_URL` or run `pnpm test:pg`.
 *
 * This is the non-interactive path to a usable deployment — the one an automated
 * deploy uses, and the way back in after sign-up has closed — so it is worth
 * proving end to end rather than by unit-testing its parts.
 */
const url = process.env.TEST_POSTGRES_URL;

if (process.env.OMNI_REQUIRE_PG === "1" && !url) {
  throw new Error("OMNI_REQUIRE_PG=1 but TEST_POSTGRES_URL is unset");
}

const PASSWORD = "correct horse battery staple";

describe.skipIf(!url)("create-admin (integration)", () => {
  /**
   * Its own **database**, not its own schema.
   *
   * The command is only reachable through an environment variable holding a
   * connection URL, and `pg` silently drops an `options=-c search_path=…`
   * parameter from a URL — every encoding of it — so a schema cannot be scoped
   * this way at all. The previous attempt to do so left this suite running in
   * `public`, sharing it with anything else that landed there: the symptom was
   * this suite failing against *another* suite's schema after that suite had
   * dropped it. A separate database is isolation the URL can actually express.
   */
  const database = `omni_cli_${process.pid.toString(36)}${Date.now().toString(36)}`;
  let admin: Pool;
  let owner: Pool;
  /** Env as the container would see it, pointed at this run's database. */
  let env: Record<string, string | undefined>;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    // `CREATE DATABASE` cannot run inside a transaction or against itself, hence
    // the separate connection that outlives it.
    await admin.query(`CREATE DATABASE ${database}`);

    const scoped = new URL(url as string);
    scoped.pathname = `/${database}`;
    owner = new Pool({ connectionString: scoped.toString() });
    env = {
      OMNI_STORAGE_TYPE: "postgres",
      OMNI_STORAGE_POSTGRES_URL: scoped.toString(),
      OMNI_ADMIN_SECRET: "b".repeat(32),
    };
  }, 30_000);

  afterAll(async () => {
    // Every connection to it has to be gone before it can be dropped.
    await owner?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.end();
  }, 30_000);

  const roleOf = async (email: string): Promise<string | null> => {
    const result = await owner.query(`SELECT role FROM "user" WHERE email = $1`, [email]);
    const role = result.rows[0]?.role;
    return typeof role === "string" ? role : null;
  };

  it("migrates, creates an operator, and grants the admin role", async () => {
    const created = await createFirstOperator({
      env,
      email: "ops@test.local",
      password: PASSWORD,
      name: "Ops",
    });
    expect(created.email).toBe("ops@test.local");
    expect(created.promoted).toBe(true);
    // An account without the role can sign in and reach nothing, so the role is
    // the whole point of the command.
    expect(await roleOf("ops@test.local")).toBe("admin");
  }, 30_000);

  it("is safe to re-run: promotes the existing account instead of failing", async () => {
    const again = await createFirstOperator({ env, email: "ops@test.local", password: PASSWORD });
    expect(again.promoted).toBe(true);
    expect(await roleOf("ops@test.local")).toBe("admin");
  }, 30_000);

  it("creates a second operator after the first, which HTTP sign-up would refuse", async () => {
    const second = await createFirstOperator({
      env,
      email: "ops2@test.local",
      password: PASSWORD,
    });
    expect(second.email).toBe("ops2@test.local");
    expect(await roleOf("ops2@test.local")).toBe("admin");
  }, 30_000);

  it("refuses without a session signing secret", async () => {
    await expect(
      createFirstOperator({
        env: { ...env, OMNI_ADMIN_SECRET: undefined },
        email: "x@test.local",
        password: PASSWORD,
      }),
    ).rejects.toThrow(/OMNI_ADMIN_SECRET/);
  });

  it("refuses when storage is not PostgreSQL, naming what to set", async () => {
    await expect(
      createFirstOperator({
        env: { OMNI_ADMIN_SECRET: "b".repeat(32), OMNI_STORAGE_TYPE: "memory" },
        email: "x@test.local",
        password: PASSWORD,
      }),
    ).rejects.toThrow(/OMNI_STORAGE_POSTGRES_URL/);
  });

  it("rejects a password Better Auth considers too weak", async () => {
    await expect(
      createFirstOperator({ env, email: "weak@test.local", password: "x" }),
    ).rejects.toThrow();
    expect(await roleOf("weak@test.local")).toBeNull();
  }, 30_000);
});
