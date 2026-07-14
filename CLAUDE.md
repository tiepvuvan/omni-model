# omni-model — Contributor Guide

omni-model is an OpenAI-compatible AI proxy you deploy yourself — to Cloudflare Workers or any
container platform (Fly.io, Cloud Run, AWS). One YAML file configures client authentication
(Firebase App Check, Apple DeviceCheck / App Attest, Firebase Auth, Supabase, custom JWT),
rate limits (request windows + token budgets), and CEL-expression-based model routing across
OpenAI-compatible, Anthropic, and Google Gemini upstreams.

This file is the contract for contributors (human or AI). Read it before changing code.

## Repository layout

```
packages/core              Runtime-agnostic engine. No Node APIs, no platform APIs.
  src/config/              YAML schema (zod) + loader with ${ENV} interpolation
  src/openai/              OpenAI wire types (permissive; unknown fields pass through)
  src/auth/                AuthVerifier contract + built-in verifiers (jwt family, apple/)
  src/providers/           ChatProvider contract + openai / anthropic / google adapters
  src/routing/             CEL expression engine + router
  src/ratelimit/           Request windows + token budgets over StorageAdapter
  src/server/              Hono app factory + pipeline.ts (transport-agnostic
                           executeChat/executeEmbeddings, shared by HTTP + callable)
  src/storage/             StorageAdapter contract + memory backend
  src/util/                SSE parsing/encoding, duration parsing
packages/storage-redis     Redis StorageAdapter (ioredis)
packages/storage-postgres  Postgres StorageAdapter (pg)
packages/storage-firestore Firestore StorageAdapter (serverless rate limits)
packages/cloudflare        Workers KV + Durable Object adapters, worker factory
packages/firebase          Callable-function adapter: Auth/App Check identity,
                           streaming chat + embeddings over the pipeline
packages/node              Node server + CLI (Docker/Fly/Cloud Run entry)
apps/cloudflare            Deployable worker (root wrangler.jsonc points here)
extensions/omni-model-proxy  One-click Firebase Extension (callable functions)
swift/OmniModelFoundation   Apple Foundation Models LanguageModel package (SPM)
swift/OmniModelClientKit    MacPaw/OpenAI client + OmniAuthMiddleware (SPM)
examples/                  Example configs + iOS client (examples/ios, ios-app)
e2e/                       Live end-to-end suite (proxy → OpenRouter; opt-in)
docs/                      Mintlify docs site (docs.json + MDX): installation,
                           security, integrations, model routing, reference
```

> Non-JS members (`swift/`, `examples/ios*`) are not part of the pnpm workspace or `pnpm ci`;
> they build with their own toolchains (`swift build`, `xcodebuild`, `tuist`). Biome ignores them.
> `e2e/` holds a live-upstream suite (`e2e/run.sh` / `pnpm test:e2e`) that is **opt-in** — it
> skips without `OPENROUTER_API_KEY` and is not in the default `pnpm test`. Never commit a key.

> Docs are a Mintlify site. A test (`packages/core/test/docs/`) validates every CEL snippet and
> config example in `docs/**/*.mdx` + `README.md` against the real schema/engine — keep them
> accurate. `has()`-guard optional-claim access in any `when:`/`match:` example.

## Architecture rules (the ones that matter)

1. **`packages/core` is runtime-agnostic.** Only Web-standard APIs (fetch, Request/Response,
   ReadableStream, WebCrypto, TextEncoder). Never `node:*` imports, never `process.env`. If you
   need platform behavior, thread it through `RuntimeContext` (`src/types.ts`).
2. **Components never touch globals.** Use `ctx.fetch`, `ctx.now()`, `ctx.log`, `ctx.waitUntil`.
   This is what makes every module testable offline and portable to Workers.
3. **Everything pluggable goes through the registry** (`src/registry.ts`). Auth verifiers,
   providers, and storage backends are factories keyed by `type`. Embedders extend by
   registering; they never fork core.
4. **Two-step config validation.** The core schema (`src/config/schema.ts`) only pins the
   discriminating `type` of storage/security/provider blocks; each factory validates its own
   options with its own zod `strictObject` and throws `ConfigError`. Config errors must fail at
   startup, never mid-request.
5. **The wire format is OpenAI's, everywhere.** Providers translate before returning
   (`ChatResult` in `src/providers/types.ts`). Streams are SSE bytes of
   `chat.completion.chunk` JSON + `data: [DONE]`. The `usage` promise on stream results must
   resolve exactly once on every exit path (done, error, client cancel) — token budgets depend
   on it.
6. **Errors are OpenAI-style.** Throw `OmniError` (or use the helpers in `src/errors.ts`);
   the server renders `{ "error": { message, type, param, code } }`.
7. **Fail-open rate limiting.** A storage outage must not take the proxy down; violations of
   this policy are bugs.

## Toolchain

- Node >= 20, pnpm 10 (`corepack enable`).
- TypeScript strict, `moduleResolution: NodeNext` — **every relative import ends in `.js`**
  and type-only imports use `import type` (verbatimModuleSyntax).
- Lint/format: **Biome** (`biome.json`): double quotes, semicolons, trailing commas, 2-space
  indent, 100-col width, no `any` (use `unknown` + narrowing). `noUncheckedIndexedAccess` is on.
- Tests: **Vitest 4**, run from the repo root.

```sh
pnpm install
pnpm build          # tsc for every package (this is also the typecheck)
pnpm test           # vitest run (all packages)
pnpm lint           # biome check .
pnpm lint:fix       # biome check --write .
pnpm ci             # lint + build + test — must be green before any PR
```

## Testing conventions

- Tests live in `packages/<pkg>/test/`, mirroring `src/` (e.g. `test/auth/jwt.test.ts` for
  `src/auth/verifiers/jwt.ts`).
- **Deterministic and offline.** Inject a fake `fetch` and a fixed `now()` via
  `RuntimeContext`; never hit the network. Real-backend integration tests must be gated:
  `describe.skipIf(!process.env.TEST_REDIS_URL)` / `TEST_POSTGRES_URL`.
- From core tests, import source by relative path with `.js` extension
  (`import { x } from "../../src/routing/router.js"` — Vitest resolves it). Cross-package
  tests import `@omni-model/core` (aliased to source in `vitest.config.ts`).
- Every bug fix ships with a regression test. Every new component ships with failure-path
  tests (bad options → `ConfigError`, invalid credential → `ok: false`, upstream 5xx → 502).
- The server suite (`packages/core/test/server/`) is the project's regression net — extend it
  when you change the pipeline.

## Adding a component (the extension recipe)

**A storage backend**: implement `StorageAdapter` + `StorageFactory`
(`core/src/storage/types.ts`) in a new package; validate options with zod; document atomicity
of `increment`. Register it in `createDefaultRegistry` only if it lives in core; external
backends are registered by the embedder.

**An auth verifier**: implement `AuthVerifier` + `AuthVerifierFactory`
(`core/src/auth/types.ts`). `verify()` returns `null` when your credential is absent,
`{ ok: false, reason }` when present-but-invalid (never echo the token), `{ ok: true, identity }`
on success. Need extra endpoints (challenge flows)? Use `routes`.

**A model provider**: implement `ChatProvider` + `ProviderFactory`
(`core/src/providers/types.ts`). Translate to/from OpenAI wire format; map upstream errors with
`upstreamErrorToResult`; honor `options.signal`; guarantee the stream `usage` promise contract.

Then: add the factory to `createDefaultRegistry` (`core/src/registry.ts`), export it from the
package barrel, add tests, and document its YAML options in `docs/reference/configuration.mdx` and
`examples/omni.yaml`.

## Style

- JSDoc on every exported symbol. Inline comments only for non-obvious constraints or
  decisions (why, not what).
- Small files, one concern each. Match the tone of `src/storage/memory.ts`.
- No new dependencies without discussion — edge compatibility (Workers) is a hard requirement
  for anything core imports. Current core deps: hono, zod, yaml, jose, @marcbachmann/cel-js,
  cbor2, @peculiar/x509.
- Never log tokens, API keys, or request bodies. Redact before logging.

## PR checklist

1. `pnpm ci` green.
2. New/changed behavior covered by tests (including failure paths).
3. Config surface changes reflected in `examples/omni.yaml` + `docs/reference/configuration.mdx`.
4. No edits to contract files (`*/types.ts`, `config/schema.ts`) without calling it out
   prominently in the PR description — downstream embedders depend on them.
