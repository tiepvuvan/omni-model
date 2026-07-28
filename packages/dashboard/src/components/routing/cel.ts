/**
 * What a routing condition may refer to, and what is wrong with one.
 *
 * The fact surface is transcribed from `RequestFacts` in
 * `packages/core/src/routing/types.ts` and checked against it by
 * `test/cel.test.ts` — a completion menu that offers a field the router does not
 * expose is worse than no menu, because CEL throws on a missing key and the
 * router treats a throw as "no match". The rule then silently never fires.
 */

export interface FactField {
  name: string;
  /** `boolean`, `string`, `number`, `map` — what an operator can do with it. */
  type: string;
  detail: string;
  /** A map whose keys are not known ahead of time; needs `has()`. */
  dynamic?: boolean;
}

export interface FactNamespace {
  name: string;
  detail: string;
  fields: readonly FactField[];
}

export const NAMESPACES: readonly FactNamespace[] = [
  {
    name: "request",
    detail: "The incoming OpenAI-format request",
    fields: [
      { name: "model", type: "string", detail: "The model the client asked for" },
      {
        name: "inputTokenCount",
        type: "number",
        detail: "Provider-neutral estimate used by the input-token limit",
      },
      { name: "maxTokens", type: "number|null", detail: "max_tokens, when the client set one" },
      { name: "temperature", type: "number|null", detail: "temperature, when the client set one" },
    ],
  },
  {
    name: "user",
    detail: "The end user, established by a verifier",
    fields: [
      { name: "id", type: "string|null", detail: "Subject of the verified token" },
      {
        name: "claims",
        type: "map",
        detail: "Token claims. Keys are not known ahead of time — guard with has()",
        dynamic: true,
      },
      {
        name: "providers",
        type: "list",
        detail: "Verifier types that accepted, such as firebase-auth or firebase-app-check",
      },
    ],
  },
  {
    name: "client",
    detail: "The calling app, from its write key",
    fields: [
      { name: "id", type: "string|null", detail: "Write key id" },
      { name: "name", type: "string|null", detail: "Write key name" },
    ],
  },
  {
    name: "http",
    detail: "The HTTP request itself",
    fields: [
      { name: "method", type: "string", detail: "Always POST for /v1/chat/completions" },
      { name: "path", type: "string", detail: "Request path" },
      { name: "ip", type: "string|null", detail: "Client IP, when a trusted header supplies it" },
      {
        name: "headers",
        type: "map",
        detail: "Lower-cased request headers, redacted — guard with has()",
        dynamic: true,
      },
    ],
  },
];

/** Root identifiers exposed by the request fact surface. */
export const ROOTS: readonly string[] = NAMESPACES.map((namespace) => namespace.name);

/** CEL built-ins worth completing. `has` is first because it is the important one. */
export const FUNCTIONS: readonly { name: string; detail: string }[] = [
  { name: "has", detail: "has(user.claims.tier) — true when a map key exists" },
  { name: "startsWith", detail: 'request.model.startsWith("claude-")' },
  { name: "endsWith", detail: 'request.model.endsWith("-mini")' },
  { name: "contains", detail: 'request.model.contains("gpt")' },
  { name: "matches", detail: 'request.model.matches("^gpt-4")' },
  { name: "size", detail: "size(request.model) — length of a string or list" },
  { name: "int", detail: "int(request.temperature) — convert to an integer" },
  { name: "string", detail: "string(request.inputTokenCount)" },
  { name: "double", detail: "double(request.maxTokens)" },
];

export const KEYWORDS: readonly string[] = ["true", "false", "null", "in"];

/* ------------------------------------------------------------- Tokenising */

export type TokenKind =
  | "identifier"
  | "namespace"
  | "function"
  | "keyword"
  | "string"
  | "number"
  | "operator"
  | "punctuation"
  | "whitespace"
  | "unknown";

export interface Token {
  kind: TokenKind;
  value: string;
  start: number;
}

const OPERATORS = [
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">=",
  "<",
  ">",
  "!",
  "+",
  "-",
  "*",
  "/",
  "%",
  "?",
  ":",
];

/**
 * Split an expression into tokens for highlighting.
 *
 * Not a parser — it never builds a tree and never rejects. Highlighting has to
 * work on a half-typed expression, which by definition does not parse, so
 * anything that threw here would leave the editor unpainted exactly while it is
 * being used.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;

  while (at < source.length) {
    const rest = source.slice(at);
    const char = source[at] as string;

    const space = /^\s+/.exec(rest);
    if (space !== null) {
      tokens.push({ kind: "whitespace", value: space[0], start: at });
      at += space[0].length;
      continue;
    }

    if (char === '"' || char === "'") {
      // Unterminated on purpose: a string being typed has no closing quote yet,
      // and colouring the rest of the line as a string is the correct hint.
      const end = source.indexOf(char, at + 1);
      const value = end === -1 ? rest : source.slice(at, end + 1);
      tokens.push({ kind: "string", value, start: at });
      at += value.length;
      continue;
    }

    const number = /^\d+(\.\d+)?/.exec(rest);
    if (number !== null) {
      tokens.push({ kind: "number", value: number[0], start: at });
      at += number[0].length;
      continue;
    }

    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (word !== null) {
      const value = word[0];
      const followedByCall = /^\s*\(/.test(rest.slice(value.length));
      const kind: TokenKind = KEYWORDS.includes(value)
        ? "keyword"
        : followedByCall || FUNCTIONS.some((fn) => fn.name === value)
          ? "function"
          : ROOTS.includes(value) && (at === 0 || !/[.\w]/.test(source[at - 1] ?? ""))
            ? "namespace"
            : "identifier";
      tokens.push({ kind, value, start: at });
      at += value.length;
      continue;
    }

    const operator = OPERATORS.find((entry) => rest.startsWith(entry));
    if (operator !== undefined) {
      tokens.push({ kind: "operator", value: operator, start: at });
      at += operator.length;
      continue;
    }

    if ("().[],{}".includes(char)) {
      tokens.push({ kind: "punctuation", value: char, start: at });
      at += 1;
      continue;
    }

    tokens.push({ kind: "unknown", value: char, start: at });
    at += 1;
  }

  return tokens;
}

/* ------------------------------------------------------------- Diagnostics */

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  message: string;
}

/**
 * What can be said about an expression without evaluating it.
 *
 * Three classes, and the third is the one that matters. A missing map key
 * *throws* in this CEL dialect, and the router turns a throw into "no match" —
 * so `user.claims.tier == "pro"` does not error in production, it silently never
 * fires, and the proxy keeps answering from a later rule. Nothing about a request
 * reveals it. That is worth a warning at the point of typing.
 *
 * The authority on whether an expression *compiles* is the server, which is why
 * the editor also asks it. This is the instant half.
 */
export function diagnose(source: string): Diagnostic[] {
  const trimmed = source.trim();
  if (trimmed === "") {
    return [{ severity: "error", message: "A condition is required — use true for a catch-all." }];
  }

  const diagnostics: Diagnostic[] = [];
  const tokens = tokenize(source);

  let depth = 0;
  for (const token of tokens) {
    if (token.value === "(") depth += 1;
    if (token.value === ")") depth -= 1;
    if (depth < 0) {
      diagnostics.push({ severity: "error", message: "Unbalanced brackets: a ) with no (." });
      break;
    }
  }
  if (depth > 0) {
    diagnostics.push({
      severity: "error",
      message: `Unbalanced brackets: ${depth} unclosed (.`,
    });
  }

  const unterminated = tokens.find(
    (token) =>
      token.kind === "string" &&
      (token.value.length < 2 || token.value.at(0) !== token.value.at(-1)),
  );
  if (unterminated !== undefined) {
    diagnostics.push({ severity: "error", message: "Unterminated string literal." });
  }

  // An identifier at the start of a path that is not a known namespace can only
  // fail at evaluation, and CEL reports it as a missing declaration.
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== "identifier") continue;
    const previous = tokens
      .slice(0, index)
      .reverse()
      .find((entry) => entry.kind !== "whitespace");
    if (previous?.value === ".") continue;
    if (ROOTS.includes(token.value) || KEYWORDS.includes(token.value)) continue;
    diagnostics.push({
      severity: "error",
      message: `Unknown identifier "${token.value}". Available: ${ROOTS.join(", ")}.`,
    });
    break;
  }

  // Reading a dynamic map's key without `has()` throws for any request lacking it.
  for (const namespace of NAMESPACES) {
    for (const field of namespace.fields) {
      if (field.dynamic !== true) continue;
      const path = `${namespace.name}.${field.name}.`;
      const reads = [...source.matchAll(new RegExp(`${path}([A-Za-z0-9_]+)`, "g"))];
      for (const read of reads) {
        const key = read[1] as string;
        const guarded =
          source.includes(`has(${path}${key})`) || source.includes(`has(${path}${key} )`);
        if (guarded) continue;
        diagnostics.push({
          severity: "warning",
          message:
            `${path}${key} throws when the key is absent, and the router treats a throw as ` +
            `no match — so this rule would silently never fire for those requests. ` +
            `Guard it: has(${path}${key}) && ${path}${key} == …`,
        });
      }
    }
  }

  if (
    trimmed !== "true" &&
    !/[=<>!]|&&|\|\||\bin\b|\.(startsWith|endsWith|contains|matches)\(|^has\(/.test(trimmed)
  ) {
    diagnostics.push({
      severity: "warning",
      message:
        "This does not look like a comparison. Only a literal true counts as a match — a truthy " +
        "string or number does not.",
    });
  }

  return diagnostics;
}

/* ------------------------------------------------------------ Completions */

export interface Completion {
  label: string;
  detail: string;
  /** What replaces the token being typed. */
  insert: string;
}

/**
 * What to offer for the word being typed at `caret`.
 *
 * Path-aware: after `user.` it offers that namespace's fields and nothing else,
 * which is the only way the menu can be trusted not to suggest something the
 * router will throw on.
 */
export function complete(source: string, caret: number): { from: number; items: Completion[] } {
  const before = source.slice(0, caret);

  const path = /([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/.exec(before);
  if (path !== null) {
    const root = path[1] as string;
    const partial = path[2] as string;
    const namespace = NAMESPACES.find((entry) => entry.name === root);
    if (namespace !== undefined) {
      return {
        from: caret - partial.length,
        items: namespace.fields
          .filter((field) => field.name.startsWith(partial))
          .map((field) => ({
            label: field.name,
            detail: `${field.type} — ${field.detail}`,
            insert: field.name,
          })),
      };
    }
    // A dynamic map: there is nothing to enumerate, so suggest the guard instead
    // of pretending to know the keys.
    if (/\.(claims|headers)\.[A-Za-z0-9_]*$/.test(before)) {
      return { from: caret - partial.length, items: [] };
    }
    return { from: caret, items: [] };
  }

  const word = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(before);
  const partial = word === null ? "" : (word[1] as string);
  const from = caret - partial.length;

  const roots = NAMESPACES.filter((entry) => entry.name.startsWith(partial)).map((entry) => ({
    label: entry.name,
    detail: entry.detail,
    insert: `${entry.name}.`,
  }));
  const functions = FUNCTIONS.filter((fn) => fn.name.startsWith(partial)).map((fn) => ({
    label: fn.name,
    detail: fn.detail,
    insert: `${fn.name}(`,
  }));
  const keywords = KEYWORDS.filter((entry) => entry.startsWith(partial)).map((entry) => ({
    label: entry,
    detail: entry === "true" ? "Matches every request — the catch-all" : "CEL literal",
    insert: entry,
  }));

  return { from, items: [...roots, ...functions, ...keywords] };
}
