import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NAMESPACES, ROOTS } from "../src/components/routing/cel";

/**
 * The completion menu must describe the facts the router actually exposes.
 *
 * This is the test that makes the editor trustworthy. A menu offering a field
 * `RequestFacts` does not have produces an expression that *throws* at evaluation
 * — and the router turns a throw into "no match", so the rule silently never
 * fires and the proxy keeps answering from a later one. An autocomplete that can
 * do that is worse than no autocomplete.
 *
 * Read from core's source rather than imported: the dashboard deliberately does
 * not depend on `@omni-model/core` at runtime, and `RequestFacts` is a type, so
 * there is nothing to import at runtime anyway.
 */
const source = readFileSync(
  join(dirname(dirname(fileURLToPath(import.meta.url))), "../core/src/routing/types.ts"),
  "utf8",
);

/** The `RequestFacts` interface body, so a later interface cannot be mistaken for it. */
function factsBlock(): string {
  const start = source.indexOf("export interface RequestFacts {");
  expect(start, "RequestFacts should exist in core").toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end);
}

/** Top-level keys of `RequestFacts` — the CEL root identifiers. */
function factRoots(): string[] {
  const block = factsBlock();
  const roots: string[] = [];
  let depth = 0;
  for (const line of block.split("\n").slice(1)) {
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (depth === 0) {
      const match = /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??:/.exec(line);
      if (match !== null) roots.push(match[1] as string);
    }
    depth += opens - closes;
  }
  return roots;
}

/**
 * Field names nested under one root.
 *
 * Handles both shapes core uses: a multi-line block, and a one-liner like
 * `device: { id: string | null };`. The one-liner has to be detected *first* —
 * scanning for the next `\n  }` from a single-line declaration runs straight past
 * it into the following block and returns that one's fields instead.
 */
function factFields(root: string): string[] {
  const block = factsBlock();
  const start = block.indexOf(`\n  ${root}: {`);
  if (start === -1) return [];

  const lineEnd = block.indexOf("\n", start + 1);
  const firstLine = block.slice(start + 1, lineEnd === -1 ? undefined : lineEnd);
  if (firstLine.includes("}")) {
    const inner = firstLine.slice(firstLine.indexOf("{") + 1, firstLine.lastIndexOf("}"));
    return [...inner.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\??:/g)].map((match) => match[1] as string);
  }

  const end = block.indexOf("\n  }", start);
  const body = block.slice(start, end === -1 ? undefined : end);
  return [...body.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map(
    (match) => match[1] as string,
  );
}

describe("the completion surface matches RequestFacts", () => {
  it("offers every root the router exposes, and no others", () => {
    expect([...ROOTS].sort()).toEqual(factRoots().sort());
  });

  it("offers every field of every namespace, and no others", () => {
    for (const namespace of NAMESPACES) {
      const declared = factFields(namespace.name);
      expect(declared.length, `${namespace.name} should have fields in core`).toBeGreaterThan(0);
      expect(
        namespace.fields.map((field) => field.name).sort(),
        `${namespace.name} completions should match RequestFacts`,
      ).toEqual(declared.sort());
    }
  });

  it("marks exactly the maps whose keys are unknowable", () => {
    // These are the two that need `has()`. Getting this list wrong is how the
    // unguarded-read warning would stop firing for a real trap.
    const dynamic = NAMESPACES.flatMap((namespace) =>
      namespace.fields
        .filter((field) => field.dynamic === true)
        .map((f) => `${namespace.name}.${f.name}`),
    );
    expect(dynamic.sort()).toEqual(["http.headers", "user.claims"]);
  });

  it("types every field it offers", () => {
    for (const namespace of NAMESPACES) {
      for (const field of namespace.fields) {
        expect(field.type, `${namespace.name}.${field.name}`).not.toBe("");
        expect(field.detail.length, `${namespace.name}.${field.name}`).toBeGreaterThan(4);
      }
    }
  });
});
