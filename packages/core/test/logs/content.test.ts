import { describe, expect, it } from "vitest";
import { captureRequestBody, captureRequestHeaders } from "../../src/logs/content.js";

describe("request-detail capture", () => {
  it("redacts credential-shaped fields recursively before storing a body", () => {
    const captured = captureRequestBody(
      {
        model: "smart",
        apiKey: "sk-secret",
        nested: {
          access_token: "jwt-secret",
          password: "password-secret",
          prompt: "keep me",
        },
      },
      4_096,
    );

    expect(captured).toEqual({
      value: {
        model: "smart",
        apiKey: "[REDACTED]",
        nested: {
          access_token: "[REDACTED]",
          password: "[REDACTED]",
          prompt: "keep me",
        },
      },
      truncated: false,
    });
    expect(JSON.stringify(captured)).not.toContain("sk-secret");
    expect(JSON.stringify(captured)).not.toContain("jwt-secret");
    expect(JSON.stringify(captured)).not.toContain("password-secret");
  });

  it("retains header names while redacting credentials", () => {
    const captured = captureRequestHeaders(
      new Headers({
        authorization: "Bearer secret-publishable-key",
        cookie: "session=secret-cookie",
        "content-type": "application/json",
        "x-firebase-appcheck": "secret-app-check",
        "x-firebase-id-token": "secret-user-token",
        "x-request-trace": "trace-1",
      }),
      4_096,
    );

    expect(captured.value).toEqual({
      authorization: "[REDACTED]",
      "content-type": "application/json",
      cookie: "[REDACTED]",
      "x-firebase-appcheck": "[REDACTED]",
      "x-firebase-id-token": "[REDACTED]",
      "x-request-trace": "trace-1",
    });
    expect(JSON.stringify(captured)).not.toContain("secret-user-token");
    expect(JSON.stringify(captured)).not.toContain("secret-cookie");
    expect(JSON.stringify(captured)).not.toContain("secret-app-check");
    expect(JSON.stringify(captured)).not.toContain("secret-publishable-key");
  });

  it("caps large bodies and marks them as partial", () => {
    const captured = captureRequestBody({ prompt: "x".repeat(1_000) }, 40);

    expect(captured.truncated).toBe(true);
    expect(typeof captured.value).toBe("string");
    expect(String(captured.value).length).toBeLessThanOrEqual(40);
  });
});
