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
  src/secrets/             JWE (dir + A256GCM) sealing via jose, keyring, and the
                           {"$secret": id} resolver
  src/cache/               PromptCache contract, key derivation, memory impl
  src/writekeys/           Per-client API keys: format, store, TTL cache
  src/logs/                Request log sink: fail-open buffering, content capping
  src/openai/              OpenAI wire types (permissive; unknown fields pass through)
  src/auth/                AuthVerifier contract + built-in verifiers (jwt family, apple/);
                           each declares its `layer`: "user" (one, required) or "app"
  src/providers/           ChatProvider contract + openai / anthropic / google adapters
  src/routing/             CEL expression engine + router
  src/ratelimit/           Per-user token budgets + the in-flight bound, over
                           StorageAdapter
  src/server/              Hono app factory + pipeline.ts (transport-agnostic
                           executeChat/executeEmbeddings) + lifecycle.ts (drain)
  src/storage/             StorageAdapter contract + memory backend
  src/util/                SSE parsing/encoding, duration parsing
packages/postgres          PostgreSQL backend: owns the schema
  src/schema.ts            Drizzle table definitions — the source of truth
  src/db.ts                Drizzle handle over the shared pool
  src/migrations/          One generated baseline + advisory-locked runner
  src/storage.ts           StorageAdapter over omni_kv (atomic counters)
  src/config-store.ts      ConfigStore over omni_config_revisions (poll + LISTEN)
  src/secret-store.ts      SecretRowStore over omni_secrets (one opaque JWE)
  src/write-key-store.ts   WriteKeyStore over omni_write_keys (hashes only)
  src/request-log-store.ts Batched log writes, queries, advisory-locked sweep
  src/prompt-cache.ts      Response cache: expiry on read, advisory-locked eviction
  src/backend.ts           Storage + config + secret stores over one pool
packages/admin             Operator API. Authorization + HTTP over existing stores
  src/auth.ts              Better Auth instance, its migrator, first-operator helpers
  src/session.ts           requireAdmin: 401 unauthenticated vs 403 not-an-operator
  src/app.ts               Hono sub-app; the first-run sign-up gate lives here
  src/routes/              config · writekeys · secrets · logs · meta · cache
packages/node              Node server + CLI — the container entry point
  src/dashboard.ts         Serves the built dashboard at /admin, SPA history fallback
packages/dashboard         Operator console. TanStack Start SPA over the admin API
  design/*.tokens.json     The Figma variable export — the source of truth for colour
  scripts/generate-theme   Turns that export into src/theme.css (never hand-edited)
  scripts/verify-build     Post-build: every asset the shell links must exist
  src/lib/api.ts           The one typed client for /admin/api
  src/components/          schema-form (forms from /meta) · ui/primitives (Base UI)
                           routing/ (Monaco + the CEL language) · ratelimit/
  src/routes/              _app guard · sign-in · setup · routing · authentication
                           rate-limit · settings
swift/OmniModelFoundation   Apple Foundation Models LanguageModel package (SPM)
swift/OmniModelClientKit    MacPaw/OpenAI client + OmniAuthMiddleware (SPM)
examples/                  Example configs + iOS client (examples/ios, ios-app)
e2e/                       End-to-end suites (opt-in; two independent gates)
docs/                      Mintlify docs site (docs.json + MDX): installation,
                           security, integrations, model routing, reference
```

> The dashboard's `build` is `tsc --noEmit && vite build && verify-build`, so `pnpm build` also
> typechecks it and refuses a bundle whose shell links an asset the build did not write. Its tests
> mount the real router at a real URL against a fake `fetch`, so guards and loaders actually run;
> `test/support/render.tsx` explains the one shim that is needed (the shell's `<html>` cannot nest
> inside a test container).

> Non-JS members (`swift/`, `examples/ios*`) are not part of the pnpm workspace or `pnpm run ci`;
> they build with their own toolchains (`swift build`, `xcodebuild`, `tuist`). Biome ignores them.
> `e2e/` is never in the default `pnpm test` (separate `vitest.e2e.config.ts`) and has two gates.
> `TEST_POSTGRES_URL` runs `admin-api` (the whole operator journey from an empty database) and
> `config-reload` (two instances over one database); these are free and run in CI.
> `OPENROUTER_API_KEY` runs the live-upstream suites — the proxy (chat/streaming/tools), the
> Firebase and Apple verifiers against real credentials, and the two Swift clients via
> `e2e/run.sh`. Never commit a key — configs reference `${OPENROUTER_API_KEY}` from the env.

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
   A dashboard sends a credential as plaintext, so the admin save path seals it
   (`sealCredentials`, field names in `CREDENTIAL_FIELDS`) *before* validating and persisting. An
   existing reference passes through untouched — sealing it again would mint a row per save.
9. **Cryptography lives in exactly one place, and is not ours.** `secrets/envelope.ts` is a thin
   wrapper over jose's JWE (`dir` + `A256GCM`); a backend implements `SecretRowStore` and moves one
   opaque string. Never hand-roll a second sealing format, and never store the key id in a column —
   it is in the `kid` header, and a projection that can disagree with the ciphertext is worse than a
   parse. `SecretStore.reveal` is the only path to plaintext and is named to be conspicuous in
   review — an admin API must not call it.
10. **The wire format is OpenAI's, everywhere.** Providers translate before returning
   (`ChatResult` in `src/providers/types.ts`). Streams are SSE bytes of
   `chat.completion.chunk` JSON + `data: [DONE]`. The `usage` promise on stream results must
   resolve exactly once on every exit path (done, error, client cancel) — token budgets depend
   on it.
11. **Errors are OpenAI-style.** Throw `OmniError` (or use the helpers in `src/errors.ts`);
    the server renders `{ "error": { message, type, param, code } }`.
12. **Fail-open rate limiting.** A storage outage must not take the proxy down; violations of
    this policy are bugs.
13. **`Authorization: Bearer` is the publishable-key transport.** This keeps the proxy compatible
    with OpenAI SDKs, whose `apiKey` already uses that header. End-user verifiers use dedicated
    `X-*` headers (`X-Firebase-ID-Token`, `X-Clerk-Session-Token`, `X-Cognito-ID-Token`,
    `X-Supabase-Access-Token`, or `X-Omni-User-Token`). Publishable keys answer "which app";
    verifiers answer "which user" — keep the two axes separate.
14. **Request logging is observability, not bookkeeping.** `RequestLogSink.record` must never throw
    or block, the queue is bounded and drops oldest, and a database outage degrades logging while
    requests keep flowing. Content capture is opt-in and byte-capped — an unbounded buffer fed by
    responses you have not inspected is an out-of-memory condition waiting to happen.
15. **Never log or echo a credential.** Config errors name *paths*, never values — there are tests
    asserting no plaintext reaches an error message or a log field. Keep it that way.
16. **Admin writes are validate → persist → apply, in that order.** `holder.validate()` is a dry run
    for exactly this. Applying before persisting would leave one replica running a configuration no
    other replica has if the write then failed; other replicas adopt the revision from the store.
17. **The admin API adds authorization and transport, not mechanism.** Every endpoint drives a
    contract core already owns, and every mutation is validated by the *same* two-step schema
    startup uses — so the API rejects exactly what a boot would have rejected, with the same
    message. If an endpoint needs new behavior, that behavior belongs in core.
18. **First-run is open exactly once, and it ends somewhere usable.** Sign-up is reachable only while
    zero accounts exist, and the account it creates is promoted to `admin` — the plugin defaults new
    accounts to `user`, which can sign in and reach nothing. `create-admin` is the non-HTTP path.
    Both are guarded by tests; the gate is the only thing between a public port and a config API.
19. **A shutdown finishes the answers it started.** `RequestTracker` counts a request until its
    response *body* is written, which for an SSE stream is long after the handler returned — that
    window is the whole point. Shutdown refuses new work, keeps listening (a closed socket makes
    `/readyz` unreachable, and an unreachable probe drains nothing), waits, then closes. Bounded by
    `OMNI_SHUTDOWN_DRAIN_MS`: one client holding a stream open must not stall a deploy.
20. **Upstreams are named once; rules only select them.** The top-level `providers` map owns provider
    types, endpoints and credentials. `routing.rules[].target` carries a primary provider id, an
    optional different fallback provider id, and the model. Bundle construction resolves every
    reference and rejects a dangling primary or fallback before the revision can serve. Rules are
    ordered and the first match wins — a catch-all is `when: "true"`, and no match is a 404.
    `RouteDecision` returns the resolved provider objects, so request handling never looks them up
    again mid-flight.
21. **The Drizzle schema is the source of truth; drizzle-kit is a generator, not the migrator.**
    Ours takes `pg_advisory_xact_lock` over the whole set in one transaction, so concurrent boots
    cannot half-apply; drizzle-kit's does not. Generated SQL is embedded, never read from files, and
    its `"public".` qualifiers must be stripped — they pin the schema and break per-schema isolation.
22. **Authentication is two layers, and only one of them is required.** `security.userAuth` is one
    verifier answering "which user", and it is mandatory — every rate limit counts tokens against
    `user.id`, so a request with no user has nothing to charge. `security.appAuth` is any number of
    verifiers answering "which app", layered over it, combined by `mode` (`any` as soon as you serve
    more than one platform, since a client can only satisfy its own). A factory's `layer` decides
    which half it belongs to and `/meta` publishes it, so a new verifier needs no dashboard change;
    a verifier configured in the wrong half is refused by name at bundle build. Attesting an app is
    never the same as knowing who is calling.
23. **Rate limits are per-user token budgets, and nothing else.** No counter key, no request-count
    window: tokens are what a request costs. Every rule whose `when` matches is enforced, so budgets
    layer and the first exhausted rejects; a rule with no `when` is a baseline, not a fallback.
    `check` is read-only and `recordUsage` charges afterwards, so one request can overshoot its
    budget — what a completion costs is not knowable until it exists.
24. **A cache hit must be indistinguishable from a fresh call, except for what it did not do.**
    What is stored is the *upstream's* answer, before redaction, so serving it runs the same
    redaction path and a replay carries the replaying request's identifiers rather than the
    identifiers of whoever populated the entry. A hit costs no upstream tokens, so it is not charged
    to a budget, and it is marked `cached` in the log row — a zero-token row with no explanation
    reads as a request that failed to account for itself. Errors are never cached, `get` must read a
    backend failure as a miss, and the key covers the resolved upstream, the resolved model, the
    stream flag and the whole body (unknown fields included: they reach the upstream, so they change
    the answer).
25. **The dashboard renders forms from the API, and colour from the token export.**
    A component's form comes from the JSON Schema `GET /admin/api/meta` publishes, so a provider
    added to the registry gets a working form with no dashboard change and a form cannot accept what
    a factory rejects. Colour comes from `design/*.tokens.json` via a generator, and a test fails the
    build if `theme.css` is stale — a hand-copied hex is the one thing that silently stops matching
    the design. The dashboard never imports `@omni-model/core` at runtime: it would pull hono, zod,
    jose and the CEL engine into a browser bundle. Where it must duplicate a constant, a test asserts
    parity with core's copy.

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
pnpm test           # vitest run — two projects: `engine` (node) and `dashboard`
                    # (jsdom + JSX); DB-backed suites skip without a database
pnpm test:pg        # starts PostgreSQL in Docker, then runs everything
pnpm test:pg:up     # just start it (for TEST_POSTGRES_URL=… pnpm test:e2e)
pnpm test:pg:down   # stop it
pnpm test:e2e       # e2e/: admin-api + config-reload need TEST_POSTGRES_URL,
                    # the rest need OPENROUTER_API_KEY; each skips without its gate
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
  Postgres schema so "applies from scratch" is a real assertion, not leftover state — **except a
  suite that runs Better Auth's migrator, which needs its own `CREATE DATABASE`.** That migrator
  introspects with Kysely, which enumerates the whole database and then queries what it found, so a
  sibling suite dropping *its* schema in between fails the query with `schema … does not exist`
  naming a schema the suite has never heard of. A scoped `search_path` does not help, because the
  introspection is not scoped by it — and `pg` silently drops `options=-c search_path=…` from a
  connection URL in every encoding, so scoping that way does nothing at all.
- **Do not assert generated SQL.** Drizzle writes the statements now, so pinning their text would
  test its codegen and break on a dependency bump. `packages/postgres/test/support/fake-pool.ts`
  recognises *operations* and implements the semantics Drizzle cannot give us (expiry, upsert
  accumulation); whether the SQL is valid is a question only `integration.test.ts` answers. A stub
  used with Drizzle must accept its `query(queryConfig, values)` form and `rowMode: "array"`.
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

**A database change**: edit `packages/postgres/src/schema.ts`, then
`pnpm --filter @omni-model/postgres run schema:generate` and append the diff to `MIGRATIONS` in
`migrations/sql.ts` with the next version. Strip drizzle-kit's `"public".` qualifiers. Never
renumber, edit, or delete a shipped migration — applied versions are recorded in `omni_migrations`,
so an edited migration silently never runs where it already applied. Every relation is
`omni_`-prefixed (a test enforces this), and the runner applies the whole set in one advisory-locked
transaction, so concurrent boots and half-applied schemas are both impossible. Anything Drizzle
cannot express (the `NOTIFY` trigger) is appended by hand and documented in `schema.ts` so the next
regeneration does not lose it. Commit `.drizzle/` — its `meta/` snapshot is what makes the *next*
`generate` a diff rather than another full baseline.

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
`docs/reference/configuration.mdx`. Always set `optionsSchema` — `GET /admin/api/meta` publishes it
as JSON Schema so a dashboard can render a form for your component, and a missing schema is an
empty form rather than an error.

**An admin endpoint**: add it to the right file under `packages/admin/src/routes/`, mounted below
`requireAdmin`. Mutations go through the `save()` helper in `routes/config.ts` so they cannot skip
validate-then-persist-then-apply. Then add it to the table in `docs/reference/admin-api.mdx`: a test
(`packages/admin/test/docs.test.ts`) drives every documented path against the real routing table, so
a documented endpoint that does not exist fails CI.

## Style

- JSDoc on every exported symbol. Inline comments only for non-obvious constraints or
  decisions (why, not what).
- Small files, one concern each. Match the tone of `src/storage/memory.ts`.
- No new dependencies without discussion. Anything `packages/core` imports must be Web-standard
  only — that constraint is what keeps every component unit-testable offline (see rule 1), so it
  stays even though the container is the only deploy target. Current core deps: hono, zod, jose,
  @marcbachmann/cel-js, cbor2, @peculiar/x509. `better-auth` is confined to `packages/admin`,
  `drizzle-orm` and `pg` to `packages/postgres`; neither may be imported by core.
- Never log tokens, API keys, or request bodies. Redact before logging.

## PR checklist

1. `pnpm run ci` green.
2. New/changed behavior covered by tests (including failure paths).
3. Config surface changes reflected in `docs/reference/configuration.mdx`.
4. No edits to contract files (`*/types.ts`, `config/schema.ts`) without calling it out
   prominently in the PR description — downstream embedders depend on them.
