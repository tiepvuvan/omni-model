import { OmniError } from "@omni-model/core";
import { describe, expect, test } from "vitest";
import {
  CallableError,
  callableErrorFromStatus,
  identityFromCallable,
  toCallableError,
} from "../src/identity.js";

/** Run `fn`, returning the thrown CallableError (failing the test otherwise). */
function catchCallableError(fn: () => unknown): CallableError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CallableError) return error;
    throw error;
  }
  throw new Error("expected the function to throw a CallableError");
}

describe("callableErrorFromStatus", () => {
  test.each([
    [400, "invalid-argument"],
    [401, "unauthenticated"],
    [403, "permission-denied"],
    [404, "not-found"],
    [429, "resource-exhausted"],
    [503, "unavailable"],
    [500, "internal"],
    [418, "internal"],
  ])("maps %i -> %s", (status, code) => {
    const error = callableErrorFromStatus(status, "boom");
    expect(error).toBeInstanceOf(CallableError);
    expect(error.code).toBe(code);
    expect(error.message).toBe("boom");
  });
});

describe("toCallableError", () => {
  test("passes an existing CallableError through unchanged", () => {
    const original = new CallableError("not-found", "missing", { hint: 1 });
    expect(toCallableError(original)).toBe(original);
  });

  test("maps an OmniError by its status", () => {
    const error = toCallableError(new OmniError(429, "slow down"));
    expect(error.code).toBe("resource-exhausted");
    expect(error.message).toBe("slow down");
  });

  test("collapses unknown errors to a generic internal error without leaking details", () => {
    const error = toCallableError(new Error("secret stack trace"));
    expect(error.code).toBe("internal");
    expect(error.message).toBe("internal error");
    expect(error.message).not.toContain("secret");
  });
});

describe("identityFromCallable", () => {
  const bothPresent = {
    data: {},
    auth: { uid: "user-1", token: { plan: "pro", sub: "user-1" } },
    app: { appId: "app-1" },
  };

  test("returns firebase identity with uid, device id and claims when both are present", () => {
    const identity = identityFromCallable(bothPresent, {
      requireAuth: true,
      requireAppCheck: true,
    });
    expect(identity).toEqual({
      provider: "firebase",
      userId: "user-1",
      deviceId: "app-1",
      claims: { plan: "pro", sub: "user-1" },
    });
  });

  test("throws failed-precondition when App Check is required but absent", () => {
    const error = catchCallableError(() =>
      identityFromCallable(
        { data: {}, auth: { uid: "u" } },
        { requireAuth: false, requireAppCheck: true },
      ),
    );
    expect(error.code).toBe("failed-precondition");
  });

  test("throws unauthenticated when the App Check token was already consumed", () => {
    const error = catchCallableError(() =>
      identityFromCallable(
        { data: {}, app: { appId: "a", alreadyConsumed: true } },
        { requireAuth: false, requireAppCheck: true },
      ),
    );
    expect(error.code).toBe("unauthenticated");
  });

  test("throws unauthenticated when auth is required but absent", () => {
    const error = catchCallableError(() =>
      identityFromCallable(
        { data: {}, app: { appId: "a" } },
        { requireAuth: true, requireAppCheck: false },
      ),
    );
    expect(error.code).toBe("unauthenticated");
  });

  test("permits an anonymous identity when neither is required", () => {
    const identity = identityFromCallable(
      { data: {} },
      { requireAuth: false, requireAppCheck: false },
    );
    expect(identity).toEqual({ provider: "firebase", claims: {} });
    expect(identity.userId).toBeUndefined();
    expect(identity.deviceId).toBeUndefined();
  });
});
