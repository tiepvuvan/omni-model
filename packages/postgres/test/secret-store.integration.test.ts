import { createKeyring, EnvelopeSecretStore, sealedKeyId, silentLogger } from "@omni-model/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runMigrations } from "../src/migrations/run.js";
import type { PgPoolLike } from "../src/pool.js";
import { PostgresSecretRowStore } from "../src/secret-store.js";

/**
 * Encrypted secrets against a real PostgreSQL. Opt in with `TEST_POSTGRES_URL`
 * or run `pnpm test:pg`.
 */
const url = process.env.TEST_POSTGRES_URL;

if (process.env.OMNI_REQUIRE_PG === "1" && !url) {
  throw new Error("OMNI_REQUIRE_PG=1 but TEST_POSTGRES_URL is unset");
}

const CANARY = "sk-plaintext-canary-value";
const schema = `omni_sec_${process.pid.toString(36)}${Date.now().toString(36)}`;
const pools: Pool[] = [];

function keyMaterial(seed: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(seed)));
}

function scopedPool(): PgPoolLike {
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  pools.push(pool);
  return pool as unknown as PgPoolLike;
}

describe.skipIf(!url)("PostgresSecretRowStore (integration)", () => {
  let admin: Pool;
  let pool: PgPoolLike;
  let store: EnvelopeSecretStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    pool = scopedPool();
    await runMigrations(pool, { logger: silentLogger });
    store = new EnvelopeSecretStore(
      new PostgresSecretRowStore(pool),
      await createKeyring({ active: keyMaterial(1) }),
      { type: "postgres" },
    );
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
  });

  test("stores one sealed text column, with no key id beside it", async () => {
    // The sealed value carries its own key id in the JWE header, so a `key_id`
    // column would be a projection that could disagree with the ciphertext.
    const columns = await pool.query(
      "SELECT column_name, data_type FROM information_schema.columns " +
        "WHERE table_schema = $1 AND table_name = 'omni_secrets' ORDER BY column_name",
      [schema],
    );
    const byName = new Map(
      columns.rows.map((row) => [String(row.column_name), String(row.data_type)]),
    );
    expect(byName.get("jwe")).toBe("text");
    expect(byName.has("key_id")).toBe(false);
    expect(byName.has("ciphertext")).toBe(false);
    expect(byName.has("iv")).toBe(false);
  });

  test("round-trips a secret", async () => {
    const description = await store.put("openai", CANARY);
    expect(description.hint).toBe("…alue");
    expect(description.keyId).toMatch(/^[0-9a-f]{12}$/);
    expect(await store.reveal(description.id)).toBe(CANARY);
  });

  test("the database never contains the plaintext", async () => {
    // The claim a backup has to satisfy. Cast the whole row to text and look.
    const dump = await pool.query(
      "SELECT id::text || name || jwe || hint || fingerprint AS blob FROM omni_secrets",
    );
    const blob = dump.rows.map((row) => String(row.blob)).join("\n");

    expect(blob).not.toContain(CANARY);
    expect(blob).not.toContain("canary");
    // ...and the value is genuinely in there, encrypted.
    expect(blob.length).toBeGreaterThan(CANARY.length);
  });

  test("what is stored is a compact JWE, readable by any JOSE implementation", async () => {
    const rows = await pool.query("SELECT jwe FROM omni_secrets LIMIT 1");
    const jwe = String(rows.rows[0]?.jwe);
    expect(jwe.split(".")).toHaveLength(5);
    expect(sealedKeyId(jwe)).toMatch(/^[0-9a-f]{12}$/);
  });

  test("replacing a credential keeps the id and updates the fingerprint", async () => {
    const first = await store.describeByName("openai");
    const second = await store.put("openai", "sk-rotated-credential");

    expect(second.id).toBe(first?.id);
    expect(second.fingerprint).not.toBe(first?.fingerprint);
    expect(await store.reveal(second.id)).toBe("sk-rotated-credential");

    const count = await pool.query("SELECT count(*)::int AS n FROM omni_secrets");
    expect(count.rows[0]?.n).toBe(1);
  });

  test("a second instance with the same key reads what the first wrote", async () => {
    // Replicas share the database, so they must share the ability to decrypt.
    const other = new EnvelopeSecretStore(
      new PostgresSecretRowStore(scopedPool()),
      await createKeyring({ active: keyMaterial(1) }),
    );
    const existing = await store.describeByName("openai");

    expect(await other.reveal(existing?.id ?? "")).toBe("sk-rotated-credential");
  });

  test("an instance with the wrong key cannot read it", async () => {
    const wrong = new EnvelopeSecretStore(
      new PostgresSecretRowStore(scopedPool()),
      await createKeyring({ active: keyMaterial(9) }),
    );
    const existing = await store.describeByName("openai");

    // The recorded key id is not on this keyring, which is the actionable case.
    await expect(wrong.reveal(existing?.id ?? "")).rejects.toThrow(/OMNI_ENCRYPTION_KEY_PREVIOUS/);
  });

  test("rotate() re-seals persisted rows under the new active key", async () => {
    const rows = new PostgresSecretRowStore(scopedPool());
    const before = await rows.list();
    const oldKeyId = sealedKeyId(before[0]?.jwe ?? "");
    expect(oldKeyId).not.toBe("");

    const rotated = new EnvelopeSecretStore(
      rows,
      await createKeyring({ active: keyMaterial(2), previous: [keyMaterial(1)] }),
    );
    expect(await rotated.rotate()).toEqual({ rotated: 1, total: 1 });

    const after = await rows.list();
    expect(sealedKeyId(after[0]?.jwe ?? "")).not.toBe(oldKeyId);
    expect(await rotated.reveal(after[0]?.id ?? "")).toBe("sk-rotated-credential");
    // Idempotent, so a rotation job can run on every boot.
    expect(await rotated.rotate()).toEqual({ rotated: 0, total: 1 });
  });

  test("delete removes the row", async () => {
    const existing = await store.describeByName("openai");
    expect(await store.delete(existing?.id ?? "")).toBe(true);
    expect(await store.delete(existing?.id ?? "")).toBe(false);
    expect(await store.list()).toEqual([]);
  });
});
