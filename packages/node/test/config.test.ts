import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@omni-model/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfigSource } from "../src/config.js";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("resolveConfigSource", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "omni-node-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prefers --config over every other source", async () => {
    const cliFile = join(dir, "cli.yaml");
    await writeFile(cliFile, "version: 1 # from-cli\n", "utf8");
    await writeFile(join(dir, "omni.yaml"), "version: 1 # from-fallback\n", "utf8");

    const result = await resolveConfigSource({
      cliPath: cliFile,
      env: {
        OMNI_CONFIG: "version: 1 # from-inline-env",
        OMNI_CONFIG_PATH: join(dir, "omni.yaml"),
      },
      cwd: dir,
    });

    expect(result.yaml).toContain("from-cli");
    expect(result.source).toBe(`--config ${cliFile}`);
  });

  it("resolves a relative --config path against cwd", async () => {
    await writeFile(join(dir, "relative.yaml"), "version: 1 # relative\n", "utf8");

    const result = await resolveConfigSource({ cliPath: "relative.yaml", env: {}, cwd: dir });

    expect(result.yaml).toContain("relative");
    expect(result.source).toBe("--config relative.yaml");
  });

  it("throws ConfigError when --config names a missing file", async () => {
    const error = await rejection(
      resolveConfigSource({ cliPath: join(dir, "missing.yaml"), env: {}, cwd: dir }),
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("missing.yaml");
  });

  it("uses inline YAML from OMNI_CONFIG", async () => {
    const result = await resolveConfigSource({
      env: { OMNI_CONFIG: "version: 1 # inline" },
      cwd: dir,
    });

    expect(result.yaml).toBe("version: 1 # inline");
    expect(result.source).toBe("OMNI_CONFIG env");
  });

  it("reads the file named by OMNI_CONFIG_PATH", async () => {
    const file = join(dir, "from-env.yaml");
    await writeFile(file, "version: 1 # from-env-path\n", "utf8");

    const result = await resolveConfigSource({ env: { OMNI_CONFIG_PATH: file }, cwd: dir });

    expect(result.yaml).toContain("from-env-path");
    expect(result.source).toBe(`OMNI_CONFIG_PATH ${file}`);
  });

  it("throws ConfigError when OMNI_CONFIG_PATH names a missing file", async () => {
    const error = await rejection(
      resolveConfigSource({ env: { OMNI_CONFIG_PATH: join(dir, "nope.yaml") }, cwd: dir }),
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("OMNI_CONFIG_PATH");
  });

  it("falls back to omni.yaml in cwd", async () => {
    await writeFile(join(dir, "omni.yaml"), "version: 1 # cwd-fallback\n", "utf8");

    const result = await resolveConfigSource({ env: {}, cwd: dir });

    expect(result.yaml).toContain("cwd-fallback");
    expect(result.source).toBe(join(dir, "omni.yaml"));
  });

  it("explains all four options when nothing is found", async () => {
    const error = await rejection(resolveConfigSource({ env: {}, cwd: dir }));

    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain("--config");
    expect(message).toContain("OMNI_CONFIG ");
    expect(message).toContain("OMNI_CONFIG_PATH");
    expect(message).toContain("omni.yaml");
  });

  it("treats empty OMNI_CONFIG and OMNI_CONFIG_PATH as unset", async () => {
    await writeFile(join(dir, "omni.yaml"), "version: 1 # despite-empty-env\n", "utf8");

    const result = await resolveConfigSource({
      env: { OMNI_CONFIG: "", OMNI_CONFIG_PATH: "" },
      cwd: dir,
    });

    expect(result.yaml).toContain("despite-empty-env");
  });
});
