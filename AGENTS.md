# omni-model — Contributor Guide

omni-model is an OpenAI-compatible AI proxy you deploy yourself, as **one container image backed by
PostgreSQL**. Configuration covers client authentication (Firebase App Check, Apple DeviceCheck /
App Attest, Firebase Auth, Supabase, custom JWT), rate limits (request windows + token budgets),
and CEL-expression-based model routing across OpenAI-compatible, Anthropic, and Google Gemini
upstreams.

This file is the contract for contributors (human or AI). Read it before changing code.

## Repository layout

```
packages/core              Runtime-agnostic engine. No Node APIs, no platform APIs.
  src/config/              Config schema (zod) + loader with ${ENV} interpolation
  src/configstore/         ConfigStore contract (revisions, watch) + memory impl
  src/runtime/             RuntimeBundle (immutable, per-revision) + holder that
                           builds and atomically swaps it
  src/secrets/             AES-256-GCM envelope encryption, keyring, and the
                           {"$secret": id} resolver
  src/writekeys/           Per-client API keys: format, store, TTL cache
  src/openai/              OpenAI wire types (permissive; unknown fields pass through)
  src/auth/                AuthVerifier contract + built-in verifiers (jwt family, apple/)
  src/providers/           ChatProvider contract + openai / anthropic / google adapters
  src/routing/             CEL expression engine + router
  src/ratelimit/           Request windows + token budgets over StorageAdapter
  src/server/              Hono app factory + pipeline.ts (transport-agnostic
                           executeChat/executeEmbeddings)
  src/storage/             StorageAdapter contract + memory backend
  src/util/                SSE parsing/encoding, duration parsing
packages/postgres          PostgreSQL backend: owns the schema
  src/migrations/          Versioned, forward-only migrations (advisory-locked)
  src/storage.ts           StorageAdapter over omni_kv (atomic counters)
  src/config-store.ts      ConfigStore over omni_config_revisions (poll + LISTEN)
  src/secret-store.ts      SecretRowStore over omni_secrets (opaque bytes only)
  src/write-key-store.ts   WriteKeyStore over omni_write_keys (hashes only)
  src/backend.ts           Storage + config + secret stores over one pool
packages/node              Node server + CLI — the container entry point
swift/OmniModelFoundation   Apple Foundation Models LanguageModel package (SPM)
swift/OmniModelClientKit    MacPaw/OpenAI client + OmniAuthMiddleware (SPM)
examples/                  Example configs + iOS client (examples/ios, ios-app)
e2e/                       Live end-to-end suite (proxy → OpenRouter; opt-in)
docs/                      Mintlify docs site (docs.json + MDX): installation,
                           security, integrations, model routing, reference
```

> Non-JS members (`swift/`, `examples/ios*`) are not part of the pnpm workspace or `pnpm run ci`;
> they build with their own toolchains (`swift build`, `xcodebuild`, `tuist`). Biome ignores them.
> `e2e/` holds a live-upstream suite (`e2e/run.sh` / `pnpm test:e2e`) that is **opt-in** — it
> skips without `OPENROUTER_API_KEY` and is not in the default `pnpm test`. It covers the proxy
> (chat/streaming/tools), the Firebase and Apple verifiers against real credentials, and the two
> Swift clients. Never commit a key — configs reference `${OPENROUTER_API_KEY}` from the env.

> Docs are a Mintlify site. A test (`packages/core/test/docs/`) validates every CEL snippet and
> config example in `docs/**/*.mdx` + `README.md` against the real schema/engine — keep them
> accurate. `has()`-guard optional-claim access in any `when:`/`match:` example.

## Architecture rules (the ones that matter)

1. **`packages/core` is runtime-agnostic.** Only Web-standard APIs (fetch, Request/Response,
   ReadableStream, WebCrypto, TextEncoder). Never `node:*` imports, never `process.env`. If you
   need platform behavior, thread it through `RuntimeContext` (`src/types.ts`).
2. **Components never touch globals.** Use `ctx.fetch`, `ctx.now()`, `ctx.log`, `ctx.waitUntil`.
   This is what makes every module testable offline — inject a fake clock and fake network and
   the whole engine runs deterministically.
3. **Everything pluggable goes through the registry** (`src/registry.ts`). Auth verifiers,
   providers, and storage backends are factories keyed by `type`. Embedders extend by
   registering; they never fork core.
4. **Two-step config validation.** The core schema (`src/config/schema.ts`) only pins the
   discriminating `type` of storage/security/provider blocks; each factory validates its own
   options with its own zod `strictObject` and throws `ConfigError`. Config errors must surface
   when a bundle is built, never mid-request.
5. **Configuration is dynamic; a bundle is not.** Everything configuration-derived lives on an
   immutable `RuntimeBundle` (`src/runtime/bundle.ts`), read once per request. Reconfiguring
   builds a *new* bundle and swaps one reference, so an in-flight request — including a live SSE
   stream — keeps the bundle it started with. Never capture a config value in a closure at app
   construction time: that is exactly the bug the bundle exists to prevent. If you add a
   config-derived value used per request, put it on the bundle.
6. **A bad configuration must never take a running proxy down.** `holder.reload()` never throws:
   it validates, builds, and only then swaps. A rejected document leaves the previous bundle
   serving and records the reason for `/readyz`. Storage is the one exception — it is
   bootstrap-level and fatal, because without it there is nowhere to read a fix from.
7. **Unconfigured is a valid state, and it is closed.** The app boots with no configuration:
   `/healthz` answers (so platforms don't crash-loop it), `/v1/*` returns 503 `not_configured`,
   and `/readyz` explains why. A bundle cannot exist without at least one verifier, so booting is
   never the same as being open.
8. **Stored revisions never hold a credential.** They carry `${VAR}` references (resolved from the
   environment) and `{"$secret": id}` references (decrypted from `omni_secrets`); both are resolved
   at bundle-build time. Anything reading a field straight off a stored document — the bootstrap
   storage URL, say — must `interpolateDeep` first.
   `bundle.config` is the *resolved* document and therefore contains plaintext: never serialize it
   to a client, a log, or an admin response. Return the stored revision instead.
9. **Cryptography lives in exactly one place.** `EnvelopeSecretStore` owns sealing and opening; a
   backend implements `SecretRowStore` and moves opaque bytes. Never add a second implementation of
   the envelope. `SecretStore.reveal` is the only path to plaintext and is named to be conspicuous
   in review — an admin API must not call it.
10. **The wire format is OpenAI's, everywhere.** Providers translate before returning
   (`ChatResult` in `src/providers/types.ts`). Streams are SSE bytes of
   `chat.completion.chunk` JSON + `data: [DONE]`. The `usage` promise on stream results must
   resolve exactly once on every exit path (done, error, client cancel) — token budgets depend
   on it.
11. **Errors are OpenAI-style.** Throw `OmniError` (or use the helpers in `src/errors.ts`);
    the server renders `{ "error": { message, type, param, code } }`.
12. **Fail-open rate limiting.** A storage outage must not take the proxy down; violations of
    this policy are bugs.
13. **`x-omni-key` is the write key header, never `Authorization`.** The jwt/firebase-auth/supabase
    verifiers own `Authorization` for the end user's token, and a client sends both at once. Write
    keys answer "which app"; verifiers answer "which user" — keep the two axes separate.
14. **Never log or echo a credential.** Config errors name *paths*, never values — there are tests
    asserting no plaintext reaches an error message or a log field. Keep it that way.

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
pnpm test           # vitest run (all packages; DB-backed suites skip)
pnpm test:pg        # starts PostgreSQL in Docker, then runs everything
pnpm test:pg:down   # stop it
pnpm lint           # biome check .
pnpm lint:fix       # biome check --write .
pnpm run ci         # lint + build + test — must be green before any PR
                    # (`pnpm ci` without `run` hits pnpm's reserved `ci` command)
```

## Testing conventions

- Tests live in `packages/<pkg>/test/`, mirroring `src/` (e.g. `test/auth/jwt.test.ts` for
  `src/auth/verifiers/jwt.ts`).
- **Deterministic and offline.** Inject a fake `fetch` and a fixed `now()` via
  `RuntimeContext`; never hit the network. Real-backend integration tests must be gated:
  `describe.skipIf(!process.env.TEST_POSTGRES_URL)`.
- **Gated suites must actually run somewhere.** A skipped suite reads like a passing one, so
  `pnpm test:pg` starts a real Postgres (`docker-compose.test.yml`) and CI runs the same suites
  with `OMNI_REQUIRE_PG=1`, which turns a closed gate into a failure. Give each run its own
  Postgres schema so "applies from scratch" is a real assertion, not leftover state.
- **SQL is asserted literally.** `packages/postgres/test/support/fake-pool.ts` pattern-matches the
  adapter's exact statements, so editing one fails the unit tests loudly; the real semantics are
  re-checked against a live server in `integration.test.ts`. Change both together.
- From core tests, import source by relative path with `.js` extension
  (`import { x } from "../../src/routing/router.js"` — Vitest resolves it). Cross-package
  tests import `@omni-model/core` (aliased to source in `vitest.config.ts`).
- Every bug fix ships with a regression test. Every new component ships with failure-path
  tests (bad options → `ConfigError`, invalid credential → `ok: false`, upstream 5xx → 502).
- The server suite (`packages/core/test/server/`) is the project's regression net — extend it
  when you change the pipeline.

## Adding a component (the extension recipe)

**A config-derived value used per request**: add it to `RuntimeBundle` and set it in
`buildBundle` (`core/src/runtime/bundle.ts`), then read it from the bundle in the handler. Add a
case to `test/runtime/reload.test.ts` proving a reload actually changes it — the whole class of bug
here is a value that looks dynamic but was captured once.

**A database change**: append a migration to `MIGRATIONS` in
`packages/postgres/src/migrations/sql.ts` with the next version. Never renumber, edit, or delete a
shipped migration — applied versions are recorded in `omni_migrations`, so an edited migration
silently never runs where it already applied. Every relation is `omni_`-prefixed (a test enforces
this), and the runner applies the whole set in one advisory-locked transaction, so concurrent boots
and half-applied schemas are both impossible.

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
package barrel, add tests, and document its environment variables in
`docs/reference/configuration.mdx`.

## Style

- JSDoc on every exported symbol. Inline comments only for non-obvious constraints or
  decisions (why, not what).
- Small files, one concern each. Match the tone of `src/storage/memory.ts`.
- No new dependencies without discussion. Anything `packages/core` imports must be Web-standard
  only — that constraint is what keeps every component unit-testable offline (see rule 1), so it
  stays even though the container is the only deploy target. Current core deps: hono, zod, jose,
  @marcbachmann/cel-js, cbor2, @peculiar/x509.
- Never log tokens, API keys, or request bodies. Redact before logging.

## PR checklist

1. `pnpm run ci` green.
2. New/changed behavior covered by tests (including failure paths).
3. Config surface changes reflected in `docs/reference/configuration.mdx`.
4. No edits to contract files (`*/types.ts`, `config/schema.ts`) without calling it out
   prominently in the PR description — downstream embedders depend on them.
