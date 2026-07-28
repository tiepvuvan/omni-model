import { describe, expect, it } from "vitest";
import { complete, diagnose, NAMESPACES, ROOTS, tokenize } from "../src/components/routing/cel";

describe("tokenizing", () => {
  it("classifies a namespace, a function, a string and an operator", () => {
    const kinds = tokenize('has(user.claims.tier) && request.model == "smart"')
      .filter((token) => token.kind !== "whitespace")
      .map((token) => `${token.kind}:${token.value}`);

    expect(kinds).toContain("function:has");
    expect(kinds).toContain("namespace:user");
    expect(kinds).toContain("identifier:claims");
    expect(kinds).toContain("operator:&&");
    expect(kinds).toContain('string:"smart"');
  });

  it("colours a string that is still being typed", () => {
    // Highlighting has to work on a half-typed expression — anything that only
    // handled valid input would leave the editor unpainted exactly while it is
    // being used.
    const tokens = tokenize('request.model == "sma');

    expect(tokens.at(-1)).toMatchObject({ kind: "string", value: '"sma' });
  });

  it("never throws on garbage", () => {
    for (const source of ["", "((((", '"""', "&&&", "…", "request..model"]) {
      expect(() => tokenize(source)).not.toThrow();
    }
  });
});

describe("diagnostics", () => {
  it("accepts a well-formed expression", () => {
    expect(diagnose('has(user.claims.tier) && user.claims.tier == "pro"')).toEqual([]);
  });

  it("accepts the catch-all", () => {
    expect(diagnose("true")).toEqual([]);
  });

  it("requires a condition", () => {
    expect(diagnose("  ")[0]).toMatchObject({ severity: "error" });
  });

  it("catches unbalanced brackets in both directions", () => {
    expect(diagnose("has(user.claims.tier")[0]?.message).toMatch(/unclosed/);
    expect(diagnose("user.id == null)")[0]?.message).toMatch(/no \(/);
  });

  it("catches an unterminated string", () => {
    expect(diagnose('request.model == "smart')[0]?.message).toMatch(/Unterminated/);
  });

  it("rejects an identifier the router does not expose", () => {
    // CEL reports this as a missing declaration at evaluation, which the router
    // swallows as "no match" — so the rule would silently never fire.
    const [first] = diagnose('tenant.id == "acme"');

    expect(first).toMatchObject({ severity: "error" });
    expect(first?.message).toContain("tenant");
    expect(first?.message).toContain("request");
  });

  it("warns about an unguarded claim read, which is the silent failure", () => {
    // The defect this whole feature exists for: reading a missing map key throws,
    // the router treats a throw as no match, and the proxy keeps answering from a
    // later rule. Nothing about a request reveals it.
    const [first] = diagnose('user.claims.tier == "pro"');

    expect(first).toMatchObject({ severity: "warning" });
    expect(first?.message).toContain("has(user.claims.tier)");
  });

  it("stops warning once the read is guarded", () => {
    expect(diagnose('has(user.claims.tier) && user.claims.tier == "pro"')).toEqual([]);
  });

  it("warns about a header read for the same reason", () => {
    expect(diagnose('http.headers.x_tenant == "acme"')[0]?.severity).toBe("warning");
  });

  it("warns when an expression is not a comparison at all", () => {
    // CEL's other footgun: only a literal `true` matches, so a truthy value is a
    // rule that never fires.
    expect(diagnose("request.model")[0]?.severity).toBe("warning");
  });
});

describe("completions", () => {
  it("offers the namespaces at the start", () => {
    const { items } = complete("", 0);

    expect(items.map((item) => item.label)).toEqual(expect.arrayContaining([...ROOTS]));
  });

  it("offers only that namespace's fields after a dot", () => {
    const source = "request.";
    const { items, from } = complete(source, source.length);

    expect(from).toBe(source.length);
    expect(items.map((item) => item.label)).toEqual([
      "model",
      "inputTokenCount",
      "maxTokens",
      "temperature",
    ]);
  });

  it("filters by what has been typed and replaces just that word", () => {
    const source = "request.mo";
    const { items, from } = complete(source, source.length);

    expect(items.map((item) => item.label)).toEqual(["model"]);
    expect(from).toBe(source.length - 2);
  });

  it("offers nothing inside a dynamic map rather than guessing keys", () => {
    // Claim keys are not knowable, and a menu that invented them would suggest
    // exactly the reads that throw.
    const source = "user.claims.tie";
    const { items } = complete(source, source.length);

    expect(items).toEqual([]);
  });

  it("suggests a namespace with its dot so the next menu chains", () => {
    const { items } = complete("req", 3);

    expect(items[0]).toMatchObject({ label: "request", insert: "request." });
  });

  it("suggests functions with their opening bracket", () => {
    const { items } = complete("ha", 2);

    expect(items.find((item) => item.label === "has")).toMatchObject({ insert: "has(" });
  });

  it("describes what the catch-all does", () => {
    const { items } = complete("tru", 3);

    expect(items.find((item) => item.label === "true")?.detail).toMatch(/every request/);
  });

  it("only offers fields that exist on the namespace", () => {
    // The guarantee that makes the menu trustworthy: everything it offers is a
    // real field, so accepting a suggestion cannot produce a throwing read.
    for (const namespace of NAMESPACES) {
      const source = `${namespace.name}.`;
      const { items } = complete(source, source.length);
      const names = namespace.fields.map((field) => field.name);
      expect(items.map((item) => item.label)).toEqual(names);
    }
  });
});
