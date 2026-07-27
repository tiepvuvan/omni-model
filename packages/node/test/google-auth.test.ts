import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructed: [] as Array<Record<string, unknown>>,
  getAccessToken: vi.fn(async () => "oauth-token"),
}));

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    constructor(options: Record<string, unknown>) {
      mocks.constructed.push(options);
    }

    getAccessToken = mocks.getAccessToken;
  },
}));

import { ConfigError } from "@omni-model/core";
import { createGoogleAccessTokenProvider } from "../src/server.js";

describe("createGoogleAccessTokenProvider", () => {
  beforeEach(() => {
    mocks.constructed.length = 0;
    mocks.getAccessToken.mockClear();
  });

  it("uses ADC with the requested scopes and reuses the GoogleAuth client", async () => {
    const provider = createGoogleAccessTokenProvider();
    await expect(provider({ scopes: ["scope-b", "scope-a", "scope-a"] })).resolves.toBe(
      "oauth-token",
    );
    await expect(provider({ scopes: ["scope-a", "scope-b"] })).resolves.toBe("oauth-token");

    expect(mocks.constructed).toEqual([{ scopes: ["scope-a", "scope-b"] }]);
    expect(mocks.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it("passes validated explicit service-account credentials without using them as cache keys", async () => {
    const provider = createGoogleAccessTokenProvider();
    const key = JSON.stringify({
      type: "service_account",
      client_email: "verifier@example.iam.gserviceaccount.com",
      private_key: "private-key",
      private_key_id: "key-id",
    });

    await provider({ scopes: ["scope"], serviceAccountKey: key });
    expect(mocks.constructed).toEqual([
      {
        scopes: ["scope"],
        credentials: {
          type: "service_account",
          client_email: "verifier@example.iam.gserviceaccount.com",
          private_key: "private-key",
          private_key_id: "key-id",
        },
      },
    ]);
  });

  it("rejects malformed credentials and empty access-token results", async () => {
    const provider = createGoogleAccessTokenProvider();
    await expect(
      provider({ scopes: ["scope"], serviceAccountKey: '{"private_key":"secret"}' }),
    ).rejects.toBeInstanceOf(ConfigError);

    mocks.getAccessToken.mockResolvedValueOnce("");
    await expect(provider({ scopes: ["different-scope"] })).rejects.toThrow(
      "returned no access token",
    );
  });
});
