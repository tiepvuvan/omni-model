import { describe, expect, it, vi } from "vitest";
import { baseConfig, createTestAdmin, errorOf } from "./helpers.js";

interface TestResponse {
  ok: boolean | null;
  message?: string;
  reason?: string;
  status?: number;
}

const ask = async (
  admin: Awaited<ReturnType<typeof createTestAdmin>>,
  verifier: Record<string, unknown>,
) =>
  admin.call("/admin/api/verifiers/test", {
    method: "POST",
    body: JSON.stringify({ verifier }),
  });

describe("testing a candidate authentication verifier", () => {
  it("confirms that a Firebase API key belongs to the entered project", async () => {
    const fetch = vi.fn(async () => Response.json({ projectId: "correct-project" }));
    const admin = await createTestAdmin({ config: baseConfig(), fetch });

    const response = await ask(admin, {
      type: "firebase-auth",
      projectId: "correct-project",
      apiKey: "firebase-web-key",
    });
    const body = (await response.json()) as TestResponse;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toContain("correct-project");
    expect(fetch).toHaveBeenCalledWith(
      "https://identitytoolkit.googleapis.com/v1/projects?key=firebase-web-key",
      expect.anything(),
    );
  });

  it("rejects a Firebase project id that does not match the API key", async () => {
    const admin = await createTestAdmin({
      config: baseConfig(),
      fetch: vi.fn(async () => Response.json({ projectId: "actual-project" })),
    });

    const body = (await (
      await ask(admin, {
        type: "firebase-auth",
        projectId: "mistyped-project",
        apiKey: "firebase-web-key",
      })
    ).json()) as TestResponse;

    expect(body.ok).toBe(false);
    expect(body.message).toContain("different project ID");
    expect(JSON.stringify(body)).not.toContain("firebase-web-key");
  });

  it("returns an upstream refusal as a 200 verdict", async () => {
    const admin = await createTestAdmin({
      config: baseConfig(),
      fetch: vi.fn(async () => new Response("not found", { status: 404 })),
    });

    const response = await ask(admin, {
      type: "aws-cognito",
      region: "us-east-1",
      userPoolId: "us-east-1_Missing",
      clientIds: ["client"],
    });
    const body = (await response.json()) as TestResponse;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.status).toBe(404);
  });

  it("reports when only a real client token can prove the configuration", async () => {
    const admin = await createTestAdmin({ config: baseConfig() });

    const body = (await (
      await ask(admin, {
        type: "apple-app-attest",
        teamId: "TEAM123",
        bundleId: "com.example.app",
      })
    ).json()) as TestResponse;

    expect(body.ok).toBeNull();
    expect(body.reason).toContain("real client token");
  });

  it("rejects malformed options as operator input", async () => {
    const admin = await createTestAdmin({ config: baseConfig() });

    const response = await ask(admin, { type: "aws-cognito", region: "us-east-1" });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("userPoolId");
  });

  it("rejects unknown verifier types", async () => {
    const admin = await createTestAdmin({ config: baseConfig() });

    const response = await ask(admin, { type: "not-a-verifier" });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("not-a-verifier");
  });
});
