import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readOptionalLiveInput, readRequiredLiveInput } from "../support/live-inputs.js";

describe("live-provider input gates", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "omni-live-inputs-"));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("treats an absent optional token file as a closed platform gate", () => {
    expect(readOptionalLiveInput(join(directory, "future-ios-token"))).toBeUndefined();
  });

  it("reads a present token without changing it", async () => {
    const path = join(directory, "web-token");
    await writeFile(path, "short-lived-token\n", { mode: 0o600 });
    expect(readOptionalLiveInput(path)).toBe("short-lived-token");
  });

  it("names only the variable when a required credential file is unavailable", () => {
    const secretPath = join(directory, "private-service-account");
    expect(() => readRequiredLiveInput(secretPath, "GOOGLE_APPLICATION_CREDENTIALS")).toThrow(
      "GOOGLE_APPLICATION_CREDENTIALS points to an unreadable or empty file",
    );
    try {
      readRequiredLiveInput(secretPath, "GOOGLE_APPLICATION_CREDENTIALS");
    } catch (error) {
      expect(String(error)).not.toContain(secretPath);
    }
  });
});
