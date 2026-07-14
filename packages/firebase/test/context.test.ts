import {
  ConfigError,
  createDefaultRegistry,
  omniConfigSchema,
  silentLogger,
} from "@omni-model/core";
import { describe, expect, test } from "vitest";
import { createOmniCallables } from "../src/callable.js";
import { buildOmniContext } from "../src/context.js";
import {
  buildTestContext,
  CANNED_COMPLETION,
  FIXED_NOW,
  fakeProviderFactory,
  makeConfig,
  noopFirestore,
} from "./helpers.js";

describe("buildOmniContext", () => {
  test("wires memory storage, providers, router and limiter", async () => {
    const ctx = await buildTestContext({ provider: { mode: "completion" } });
    expect(ctx.storage.type).toBe("memory");
    expect(ctx.deps.providers.has("fake")).toBe(true);
    expect(typeof ctx.deps.router.resolve).toBe("function");
    expect(typeof ctx.deps.limiter.check).toBe("function");
    expect(ctx.runtime.now()).toBe(FIXED_NOW);
  });

  test("throws ConfigError for an unknown storage type", async () => {
    const config = omniConfigSchema.parse({ storage: { type: "does-not-exist" } });
    await expect(
      buildOmniContext(config, { firestore: noopFirestore, logger: silentLogger }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("throws ConfigError for an unknown provider type", async () => {
    const config = omniConfigSchema.parse({
      storage: { type: "memory" },
      providers: { p: { type: "nope" } },
    });
    await expect(
      buildOmniContext(config, { firestore: noopFirestore, logger: silentLogger }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("registers the firestore storage factory without touching the stub for memory storage", async () => {
    // buildTestContext uses memory storage; if the firestore stub were touched
    // it would throw. Reaching here proves registration is lazy.
    const ctx = await buildTestContext({ provider: { mode: "completion" } });
    expect(ctx.storage.type).toBe("memory");
  });
});

describe("createOmniCallables", () => {
  test("builds working chat + embeddings handlers and defaults to requiring auth + App Check", async () => {
    const registry = createDefaultRegistry();
    registry.providers.set("fake", fakeProviderFactory());

    const { chat, embeddings, context } = await createOmniCallables({
      config: makeConfig({ provider: { mode: "completion", embeddings: true } }),
      firestore: noopFirestore,
      registry,
      now: () => FIXED_NOW,
      logger: silentLogger,
    });

    expect(context.storage.type).toBe("memory");
    expect(typeof embeddings).toBe("function");

    // Auth + App Check are required by default: a fully authenticated request works.
    const result = await chat({
      data: { model: "m", messages: [{ role: "user", content: "hi" }] },
      auth: { uid: "u1", token: {} },
      app: { appId: "a1" },
    });
    expect(result).toEqual(CANNED_COMPLETION);

    // Missing App Check is rejected by the default requirement.
    await expect(
      chat({
        data: { model: "m", messages: [{ role: "user", content: "hi" }] },
        auth: { uid: "u1" },
      }),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });
});
