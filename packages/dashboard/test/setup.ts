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

/**
 * What Monaco needs from a browser that jsdom does not provide.
 *
 * Monaco measures text, queries the colour scheme and observes its container, and
 * calls these unconditionally at construction. Stubbing them is what lets the
 * routing screen — which now embeds a real editor — render in a test at all.
 * Layout is meaningless in jsdom either way, so returning zeroes is honest: these
 * tests assert behaviour and wiring, never geometry.
 */
if (typeof globalThis.matchMedia !== "function") {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof globalThis.matchMedia;
}

if (typeof globalThis.queueMicrotask !== "function") {
  globalThis.queueMicrotask = (callback: VoidFunction) => {
    void Promise.resolve().then(callback);
  };
}

if (typeof Range.prototype.getBoundingClientRect !== "function") {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
if (typeof Range.prototype.getClientRects !== "function") {
  Range.prototype.getClientRects = () =>
    Object.assign([], { item: () => null, length: 0 }) as unknown as DOMRectList;
}
