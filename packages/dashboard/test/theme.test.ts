import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateTheme } from "../scripts/generate-theme.mjs";

/**
 * Read a file from the package root.
 *
 * `dirname(fileURLToPath(import.meta.url))` rather than
 * `new URL(path, import.meta.url)`: Vite treats the latter as an asset reference
 * and rewrites it, which turns a dynamic path into a URL pointing at nothing.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const tokenDocument = (name: string): Record<string, unknown> =>
  JSON.parse(read(`design/${name}`)) as Record<string, unknown>;

const generated = (): string =>
  generateTheme(tokenDocument("Light.tokens.json"), tokenDocument("Dark.tokens.json"));

/**
 * The design tokens are the source of truth for colour, and this is what keeps
 * them that way.
 *
 * `src/theme.css` is generated from the Figma variable export. Without this test
 * the generator is advisory: someone re-exports the tokens, forgets to run it,
 * and the dashboard keeps rendering last month's palette while the JSON in the
 * repo says otherwise. Here a stale stylesheet is a failing build.
 */
describe("the generated theme", () => {
  it("matches the token export", () => {
    expect(read("src/theme.css")).toBe(generated());
  });

  it("declares every token in both light and dark", () => {
    const css = read("src/theme.css");
    const tokens = (json: string): string[] => {
      const names: string[] = [];
      const walk = (node: Record<string, unknown>, path: string[]): void => {
        for (const [key, value] of Object.entries(node)) {
          if (key.startsWith("$") || value === null || typeof value !== "object") continue;
          const entry = value as Record<string, unknown>;
          if (entry.$type === "color") names.push([...path, key].join(" "));
          else walk(entry, [...path, key]);
        }
      };
      walk(JSON.parse(json) as Record<string, unknown>, []);
      return names;
    };

    const light = tokens(read("design/Light.tokens.json"));
    const dark = tokens(read("design/Dark.tokens.json"));
    expect(light.length).toBeGreaterThan(40);
    expect(new Set(dark)).toEqual(new Set(light));

    for (const name of light) {
      const variable = `--color-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      // Twice: once in `@theme` for light, once under `[data-theme="dark"]`.
      const occurrences = css.split(`${variable}:`).length - 1;
      expect(occurrences, `${variable} should be declared for both themes`).toBeGreaterThanOrEqual(
        2,
      );
    }
  });

  it("supports an explicit choice in both directions, not just the OS preference", () => {
    const css = read("src/theme.css");
    // A viewer who picked light must keep light on a dark-mode machine, so the
    // media query has to exclude an explicit light choice rather than win.
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain("prefers-color-scheme: dark");
  });

  it("uses no colour outside the token set", () => {
    // A hardcoded hex is the one thing that silently stops matching the design,
    // so the components may not contain one.
    const sources = ["src/components/ui/primitives.tsx", "src/components/chrome.tsx"];
    for (const path of sources) {
      const source = read(path);
      const hexes = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hexes, `${path} should reference tokens, not hex colours`).toEqual([]);
    }
  });
});
