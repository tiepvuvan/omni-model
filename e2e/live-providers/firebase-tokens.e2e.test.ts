import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFirebaseTestSession,
  exchangeAppCheckDebugToken,
} from "../support/firebase-tokens.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Firebase live token helpers", () => {
  it("creates and deletes a disposable anonymous user", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push({
          url,
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        return url.includes("accounts:signUp")
          ? Response.json({ idToken: "genuine-id-token" })
          : Response.json({});
      }),
    );

    const session = await createFirebaseTestSession("public-client-api-key");
    expect(session.idToken).toBe("genuine-id-token");
    await session.delete();

    expect(requests).toEqual([
      {
        url: "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=public-client-api-key",
        body: { returnSecureToken: true },
      },
      {
        url: "https://identitytoolkit.googleapis.com/v1/accounts:delete?key=public-client-api-key",
        body: { idToken: "genuine-id-token" },
      },
    ]);
  });

  it("exchanges a service-account custom token without enabling anonymous sign-in", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let signInBody: { token?: string } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("accounts:signInWithCustomToken")) {
          signInBody = JSON.parse(String(init?.body));
          return Response.json({ idToken: "exchanged-id-token" });
        }
        return Response.json({});
      }),
    );

    const session = await createFirebaseTestSession("public-client-api-key", {
      serviceAccountKey: JSON.stringify({
        type: "service_account",
        client_email: "firebase-e2e@example.test",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
    });

    expect(session.idToken).toBe("exchanged-id-token");
    const payload = JSON.parse(
      Buffer.from(signInBody.token?.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      iss: "firebase-e2e@example.test",
      sub: "firebase-e2e@example.test",
    });
    expect(payload.uid).toMatch(/^omni-e2e-/);
    await session.delete();
  });

  it("requests a limited-use App Check token without exposing the debug token", async () => {
    const debugToken = "private-debug-token";
    let requestBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({ token: "app-check-token" });
      }),
    );

    await expect(
      exchangeAppCheckDebugToken({
        apiKey: "public-client-api-key",
        projectNumber: "123456",
        appId: "firebase-app-id",
        debugToken,
        limitedUse: true,
      }),
    ).resolves.toBe("app-check-token");
    expect(requestBody).toEqual({ debugToken, limitedUse: true });
  });

  it("sanitizes Firebase errors instead of echoing remote details", async () => {
    const remoteSecret = "remote-error-that-could-contain-a-credential";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: remoteSecret } }, { status: 400 })),
    );

    let message = "";
    try {
      await createFirebaseTestSession("public-client-api-key");
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("Firebase accounts:signUp failed (400)");
    expect(message).not.toContain(remoteSecret);
  });
});
