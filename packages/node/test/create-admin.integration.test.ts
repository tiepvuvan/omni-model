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
  const schema = `omni_cli_${process.pid.toString(36)}${Date.now().toString(36)}`;
  let owner: Pool;
  /** Env as the container would see it, scoped to this run's schema. */
  let env: Record<string, string | undefined>;

  beforeAll(async () => {
    owner = new Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    // Better Auth's tables are unquoted and unqualified, so a scoped search_path
    // is what keeps this run out of the next one's way.
    const scoped = new URL(url as string);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    env = {
      OMNI_STORAGE_TYPE: "postgres",
      OMNI_STORAGE_POSTGRES_URL: scoped.toString(),
      OMNI_ADMIN_SECRET: "b".repeat(32),
    };
  }, 30_000);

  afterAll(async () => {
    await owner?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await owner?.end();
  });

  const roleOf = async (email: string): Promise<string | null> => {
    const result = await owner.query(`SELECT role FROM ${schema}."user" WHERE email = $1`, [email]);
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
