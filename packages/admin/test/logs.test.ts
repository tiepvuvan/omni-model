import type { Logger } from "@omni-model/core";
import { describe, expect, it } from "vitest";
import { baseConfig, createTestAdmin, errorOf } from "./helpers.js";

describe("request logs", () => {
  it("returns an empty page with a null cursor", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/logs");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ logs: [], nextBefore: null });
  });

  it("404s for a request id that was never logged", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/logs/req-does-not-exist");
    expect(response.status).toBe(404);
    expect((await errorOf(response)).message).toMatch(/req-does-not-exist/);
  });

  it("rejects nonsensical filters rather than silently ignoring them", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    for (const query of ["limit=0", "since=-1", "minStatus=abc"]) {
      const response = await call(`/admin/api/logs?${query}`);
      expect(response.status, query).toBe(400);
      expect((await errorOf(response)).message).toMatch(/positive/);
    }
  });

  it("summarises usage per client", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/usage/summary?hours=6");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ windowHours: 6, clients: [] });
  });
});

describe("reading prompt content is accountable", () => {
  /** A logger that keeps what it was told, so the audit trail can be asserted. */
  function recordingLogger(): { logger: Logger; warnings: Array<Record<string, unknown>> } {
    const warnings: Array<Record<string, unknown>> = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message, fields) => warnings.push({ message, ...fields }),
      error: () => {},
    };
    return { logger, warnings };
  }

  it("leaves a trace naming the operator who read it", async () => {
    const { logger, warnings } = recordingLogger();
    const { call } = await createTestAdmin({ config: baseConfig(), logger });

    await call("/admin/api/logs?includeContent=true&userId=user-9");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      message: "request log content was read",
      by: "root@test",
      userId: "user-9",
    });
  });

  it("leaves no trace when only metadata is read", async () => {
    const { logger, warnings } = recordingLogger();
    const { call } = await createTestAdmin({ config: baseConfig(), logger });
    await call("/admin/api/logs?userId=user-9");
    expect(warnings).toHaveLength(0);
  });

  it("traces a single-request lookup too", async () => {
    const { logger, warnings } = recordingLogger();
    const { call } = await createTestAdmin({ config: baseConfig(), logger });
    await call("/admin/api/logs/req-1?includeContent=true");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ by: "root@test", requestId: "req-1" });
  });
});
