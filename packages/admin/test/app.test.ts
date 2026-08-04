import { describe, expect, it } from "vitest";
import { baseConfig, createTestAdmin, errorOf, fakePool } from "./helpers.js";

/**
 * The authorization boundary and the first-run gate.
 *
 * These are the two rules that, if wrong, expose the whole configuration surface
 * to the internet — so they are asserted route by route rather than once.
 */
describe("admin authorization", () => {
  const guarded: ReadonlyArray<readonly [method: string, path: string]> = [
    ["GET", "/admin/api/me"],
    ["GET", "/admin/api/status"],
    ["GET", "/admin/api/config"],
    ["PUT", "/admin/api/config"],
    ["PATCH", "/admin/api/config"],
    ["POST", "/admin/api/config/validate"],
    ["POST", "/admin/api/verifiers/test"],
    ["GET", "/admin/api/config/revisions"],
    ["PUT", "/admin/api/security"],
    ["PUT", "/admin/api/rate-limits"],
    ["PUT", "/admin/api/routing"],
    ["PUT", "/admin/api/logging"],
    ["PUT", "/admin/api/providers"],
    ["POST", "/admin/api/providers/models"],
    ["GET", "/admin/api/write-keys"],
    ["POST", "/admin/api/write-keys"],
    ["DELETE", "/admin/api/write-keys/abc"],
    ["GET", "/admin/api/secrets"],
    ["PUT", "/admin/api/secrets"],
    ["DELETE", "/admin/api/secrets/abc"],
    ["POST", "/admin/api/secrets/rotate"],
    ["GET", "/admin/api/logs"],
    ["GET", "/admin/api/usage/summary"],
    ["GET", "/admin/api/meta"],
    ["POST", "/admin/api/routing/simulate"],
    ["GET", "/admin/api/users"],
    ["POST", "/admin/api/users/invites"],
    ["DELETE", "/admin/api/users/invites/abc"],
  ];

  /** GET and DELETE requests cannot carry one. */
  const bodyFor = (method: string): { body?: string } =>
    method === "POST" || method === "PUT" || method === "PATCH" ? { body: "{}" } : {};

  it.each(guarded)("%s %s answers 401 without a session", async (method, path) => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call(path, { method, session: null, ...bodyFor(method) });
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("admin_unauthenticated");
  });

  it.each(guarded)("%s %s answers 403 for a non-operator", async (method, path) => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call(path, { method, session: "member", ...bodyFor(method) });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("admin_forbidden");
  });

  it("identifies the operator behind the session", async () => {
    const { call } = await createTestAdmin();
    const response = await call("/admin/api/me");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      actor: { id: "u-root", email: "root@test", name: "Root", role: "admin" },
    });
  });

  it("rejects an unknown session token rather than trusting the header", async () => {
    const { call } = await createTestAdmin();
    expect((await call("/admin/api/me", { session: "forged" })).status).toBe(401);
  });
});

describe("first-run sign-up gate", () => {
  it("is open while no operator exists", async () => {
    const { call } = await createTestAdmin({ users: 0 });
    const response = await call("/admin/api/auth/sign-up/email", {
      method: "POST",
      session: null,
      body: JSON.stringify({ email: "first@test", password: "correct horse battery" }),
    });
    // Reaches Better Auth rather than being refused.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handled: "/admin/api/auth/sign-up/email" });
  });

  it("closes permanently once an operator exists", async () => {
    const { call } = await createTestAdmin({ users: 1 });
    const response = await call("/admin/api/auth/sign-up/email", {
      method: "POST",
      session: null,
      body: JSON.stringify({ email: "second@test", password: "correct horse battery" }),
    });
    expect(response.status).toBe(403);
    const error = await errorOf(response);
    expect(error.code).toBe("signup_closed");
    expect(error.message).toMatch(/create-admin/);
  });

  it("reports whether setup is still needed, without a session", async () => {
    const empty = await createTestAdmin({ users: 0 });
    expect(await (await empty.call("/admin/api/setup", { session: null })).json()).toEqual({
      needsFirstOperator: true,
      operators: 0,
    });
    const seeded = await createTestAdmin({ users: 2 });
    expect(await (await seeded.call("/admin/api/setup", { session: null })).json()).toEqual({
      needsFirstOperator: false,
      operators: 2,
    });
  });

  it("leaves sign-in reachable when sign-up is closed", async () => {
    const { call } = await createTestAdmin({ users: 1 });
    const response = await call("/admin/api/auth/sign-in/email", {
      method: "POST",
      session: null,
      body: JSON.stringify({ email: "root@test", password: "x" }),
    });
    expect(response.status).toBe(200);
  });
});

describe("status", () => {
  it("reports an unconfigured proxy", async () => {
    const { call } = await createTestAdmin();
    const body = (await (await call("/admin/api/status")).json()) as Record<string, unknown>;
    expect(body.configured).toBe(false);
    expect(body.revision).toBeNull();
    expect(body.providers).toEqual([]);
    expect(body.userAuth).toBeNull();
    expect(body.appAuth).toEqual([]);
  });

  it("reports what is applied", async () => {
    const { call } = await createTestAdmin({
      config: baseConfig({
        server: {
          organizationName: "Northstar",
          customDomain: "ai.northstar.example",
        },
      }),
    });
    const body = (await (await call("/admin/api/status")).json()) as Record<string, unknown>;
    expect(body.configured).toBe(true);
    expect(body.revision).toBe(1);
    expect(body.providers).toEqual(["default"]);
    // The two layers separately: one is required, the other optional.
    expect(body.userAuth).toBe("jwt");
    expect(body.appAuth).toEqual([]);
    expect(body.organizationName).toBe("Northstar");
    expect(body.customDomain).toBe("ai.northstar.example");
  });
});

describe("error rendering", () => {
  it("renders a malformed body as a 400 naming the field", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/write-keys", {
      method: "POST",
      body: JSON.stringify({ name: "" }),
    });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe("invalid_body");
    expect(error.message).toMatch(/name/);
  });

  it("does not leak an internal failure to the caller", async () => {
    // The fake pool throws on any query it does not recognise.
    const { call } = await createTestAdmin({ pool: fakePool({ users: 0 }) });
    const response = await call("/admin/api/setup", { session: null });
    expect(response.status).toBe(200);
  });
});
