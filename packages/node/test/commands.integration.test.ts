import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@omni-model/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importConfig } from "../src/import-config.js";
import { applyMigrations } from "../src/migrate.js";

/**
 * The `migrate` and `import-config` commands against a real PostgreSQL. Opt in
 * with `TEST_POSTGRES_URL` or run `pnpm test:pg`.
 *
 * Both exist for pipelines: a schema change as its own reviewable step, and a
 * configuration that lives in a repository. Worth proving end to end, because
 * the failure mode of a broken one is a deploy that half-succeeded.
 */
const url = process.env.TEST_POSTGRES_URL;

if (process.env.OMNI_REQUIRE_PG === "1" && !url) {
  throw new Error("OMNI_REQUIRE_PG=1 but TEST_POSTGRES_URL is unset");
}

const VALID = {
  version: 1,
  storage: { type: "postgres", url: "${OMNI_STORAGE_POSTGRES_URL}" },
  security: { providers: [{ type: "jwt", secret: "a-long-shared-development-secret" }] },
  routing: {
    rules: [{ id: "main", when: "true", target: { type: "openai", apiKey: "sk-test" } }],
  },
};

describe.skipIf(!url)("migrate and import-config (integration)", () => {
  const schema = `omni_cmd_${process.pid.toString(36)}${Date.now().toString(36)}`;
  let owner: Pool;
  let env: Record<string, string | undefined>;
  let dir: string;

  const write = async (name: string, body: unknown): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, typeof body === "string" ? body : JSON.stringify(body, null, 2));
    return path;
  };

  beforeAll(async () => {
    owner = new Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    const scoped = new URL(url as string);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    env = {
      OMNI_STORAGE_TYPE: "postgres",
      OMNI_STORAGE_POSTGRES_URL: scoped.toString(),
    };
    dir = await mkdtemp(join(tmpdir(), "omni-import-"));
  }, 30_000);

  afterAll(async () => {
    await owner?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await owner?.end();
  });

  describe("migrate", () => {
    it("applies the schema, and is a no-op the second time", async () => {
      const first = await applyMigrations({ env, logger: silentLogger });
      expect(first.applied).toEqual([1]);
      expect(first.version).toBe(1);

      // An init container that runs on every pod start must be safe to repeat.
      const second = await applyMigrations({ env, logger: silentLogger });
      expect(second.applied).toEqual([]);
      expect(second.version).toBe(1);
    }, 30_000);

    it("created every omni_ relation in the target schema", async () => {
      const tables = await owner.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
        [schema],
      );
      expect(tables.rows.map((row) => String(row.table_name)).sort()).toEqual([
        "omni_config_revisions",
        "omni_kv",
        "omni_migrations",
        "omni_request_contents",
        "omni_request_logs",
        "omni_secrets",
        "omni_write_keys",
      ]);
    });

    it("refuses without PostgreSQL storage, naming what to set", async () => {
      await expect(
        applyMigrations({ env: { OMNI_STORAGE_TYPE: "memory" }, logger: silentLogger }),
      ).rejects.toThrow(/OMNI_STORAGE_POSTGRES_URL/);
    });
  });

  describe("import-config", () => {
    it("validates, saves and activates a revision", async () => {
      const file = await write("valid.json", VALID);
      const saved = await importConfig({
        env,
        file,
        note: "from CI",
        logger: silentLogger,
      });

      expect(saved.revision).toBe(1);
      expect(saved.note).toBe("from CI");
      expect(saved.createdBy).toBe("import-config");

      const active = await owner.query(
        `SELECT id, is_active, note FROM ${schema}.omni_config_revisions WHERE is_active`,
      );
      expect(active.rows).toHaveLength(1);
      expect(Number(active.rows[0]?.id)).toBe(1);
    }, 30_000);

    it("appends a revision rather than replacing one", async () => {
      const file = await write("second.json", {
        ...VALID,
        routing: {
          allowedModels: ["gpt-4o"],
          rules: [{ id: "main", when: "true", target: { type: "openai", apiKey: "sk-test" } }],
        },
      });
      const saved = await importConfig({ env, file, logger: silentLogger });
      expect(saved.revision).toBe(2);

      const rows = await owner.query(
        `SELECT count(*)::int AS n FROM ${schema}.omni_config_revisions`,
      );
      expect(rows.rows[0]?.n).toBe(2);
    }, 30_000);

    it("rejects an invalid document without storing it", async () => {
      // The point of validating in the command: CI fails, rather than the
      // database ending up with a broken active revision.
      const file = await write("broken.json", {
        ...VALID,
        routing: {
          rules: [{ id: "main", when: "true", target: { type: "no-such-provider" } }],
        },
      });
      await expect(importConfig({ env, file, logger: silentLogger })).rejects.toThrow(
        /routing\.rules\[0\]\.target/,
      );

      const rows = await owner.query(
        `SELECT count(*)::int AS n FROM ${schema}.omni_config_revisions`,
      );
      expect(rows.rows[0]?.n).toBe(2);
    }, 30_000);

    it("rejects a document with no verifier, which would be an open relay", async () => {
      const file = await write("open.json", { ...VALID, security: { providers: [] } });
      await expect(importConfig({ env, file, logger: silentLogger })).rejects.toThrow(/open relay/);
    }, 30_000);

    it("names the file when it does not exist or is not JSON", async () => {
      await expect(
        importConfig({ env, file: join(dir, "missing.json"), logger: silentLogger }),
      ).rejects.toThrow(/missing\.json/);

      const bad = await write("bad.json", "{ not json");
      await expect(importConfig({ env, file: bad, logger: silentLogger })).rejects.toThrow(
        /bad\.json is not valid JSON/,
      );
    }, 30_000);

    it("resolves a $secret reference against the same database", async () => {
      // Validation has to use the real secret store, or a configuration that
      // references a credential would be rejected in CI and accepted at boot.
      const secretId = "11111111-2222-3333-4444-555555555555";
      const file = await write("secret.json", {
        ...VALID,
        routing: {
          rules: [
            { id: "main", when: "true", target: { type: "openai", apiKey: { $secret: secretId } } },
          ],
        },
      });

      // No master key configured: the resolver says so, naming the variable.
      await expect(importConfig({ env, file, logger: silentLogger })).rejects.toThrow(
        /OMNI_ENCRYPTION_KEY/,
      );

      // With a *real* key but no such row, the failure names the path in the
      // document instead — the difference between "you forgot the key" and "that
      // secret does not exist". Spelled out because an empty or short key would
      // take the branch above and let this pass for the wrong reason.
      const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
      const failure = await importConfig({
        env: { ...env, OMNI_ENCRYPTION_KEY: key },
        file,
        logger: silentLogger,
      }).then(
        () => new Error("expected the import to be rejected"),
        (error: unknown) => error as Error,
      );
      expect(failure.message).toMatch(/routing\.rules\[0\]\.target\.apiKey/);
      expect(failure.message).not.toMatch(/OMNI_ENCRYPTION_KEY/);
    }, 30_000);
  });
});
