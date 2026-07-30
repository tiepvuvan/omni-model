import { beforeEach, describe, expect, it } from "vitest";
import { getRouter } from "../src/router";
import { createFakeApi, type FakeApi } from "./support/fake-api";
import { renderAt } from "./support/render";

let fake: FakeApi;

beforeEach(() => {
  fake = createFakeApi();
  fake.install();
});

const PROTECTED_PAGES = [
  ["/authentication", "Authentication | Omni Model"],
  ["/logs", "Activity Logs | Omni Model"],
  ["/publishable-keys", "Public API Keys | Omni Model"],
  ["/rate-limit", "Rate Limits | Omni Model"],
  ["/routing", "Model Routing | Omni Model"],
  ["/settings", "Settings | Omni Model"],
  ["/users", "Users | Omni Model"],
] as const;

describe("page titles", () => {
  it.each(PROTECTED_PAGES)("titles %s", async (path, title) => {
    await renderAt(path);

    expect(document.title).toBe(title);
  });

  it("titles the sign-in page", async () => {
    fake.state.signedIn = false;

    await renderAt("/sign-in");

    expect(document.title).toBe("Sign In | Omni Model");
  });

  it("titles first-run setup", async () => {
    fake.state.signedIn = false;
    fake.state.operators = 0;

    await renderAt("/setup");

    expect(document.title).toBe("Admin Setup | Omni Model");
  });

  it("titles invitation acceptance even when the link is unavailable", async () => {
    await renderAt("/accept-invite");

    expect(document.title).toBe("Accept Invitation | Omni Model");
  });

  it("requires every content route to declare a title", () => {
    const router = getRouter();
    const contentRoutes = Object.entries(router.routesById).filter(
      ([id]) => id !== "__root__" && id !== "/" && id !== "/_app",
    );

    expect(contentRoutes.map(([id]) => id).sort()).toEqual(
      [
        "/accept-invite",
        "/setup",
        "/sign-in",
        "/_app/authentication",
        "/_app/logs",
        "/_app/publishable-keys",
        "/_app/rate-limit",
        "/_app/routing",
        "/_app/settings",
        "/_app/users",
      ].sort(),
    );

    for (const [id, route] of contentRoutes) {
      expect(route.options.head, `${id} must declare head metadata`).toBeTypeOf("function");
    }
  });
});
