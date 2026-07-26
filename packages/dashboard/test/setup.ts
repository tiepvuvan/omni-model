import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * jsdom implements neither of these, and Base UI's popups use both — a Select
 * that cannot open makes every form test unreachable.
 */
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => undefined;
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
}

// The router restores scroll on every navigation, and jsdom logs a "not
// implemented" for each one. Stubbing it keeps a passing run readable.
globalThis.scrollTo = () => undefined;
