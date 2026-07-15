# End-to-end tests

These exercise the **whole chain** against a real upstream — the omni-model proxy plus both Swift
integrations — so a regression anywhere (routing, translation, streaming, auth, the Foundation
Models executor) fails a test instead of a shipped app.

They're **opt-in** and cost a few tenths of a cent (tiny prompts, `openai/gpt-4o-mini`). Get an
[OpenRouter](https://openrouter.ai) key, then:

```sh
OPENROUTER_API_KEY=sk-or-... e2e/run.sh
```

## What runs

| Suite | Command | Covers |
| --- | --- | --- |
| **Node** | `pnpm test:e2e` | Real `@omni-model/node` server → OpenRouter: chat, **streaming**, a **tool-calling round-trip**, usage, and an upstream-error case. |
| **Cloudflare Worker** | `pnpm test:e2e` | The real worker running in **workerd** (`wrangler dev`) → OpenRouter: boots + parses config, chat, **SSE streaming through workerd**, and **Durable Object** rate limiting (a burst trips a 429). |
| **MacPaw** | `swift test` in `swift/OmniModelClientKit` (macOS) | MacPaw/OpenAI client + `OmniAuthMiddleware` → proxy: chat + streaming. |
| **Foundation Models** | `xcodebuild test` in `swift/OmniModelFoundation` (iOS 27 sim) | `LanguageModelSession` → `OmniProxyExecutor` → proxy: `respond` + streaming. |

`e2e/run.sh` runs all of them. `pnpm test:e2e` covers the first two: the Node suite boots its own
ephemeral server, and the Worker suite (`cloudflare-worker.e2e.test.ts`) starts `wrangler dev` on
`http://127.0.0.1:8799` in a subprocess — running the genuine `createWorker` + `OmniStorageDurableObject`
from `e2e/cloudflare/` (requires a prior `pnpm build`), passing the key via `--var` so it never
touches disk, and tearing the process group down on exit. The Swift suites talk to a proxy the script
starts on `http://localhost:8788` (the iOS simulator reaches the host's `localhost`).

## Self-guarding

- The Node and Worker E2E tests **skip themselves** when `OPENROUTER_API_KEY` is unset — so
  `pnpm test:e2e` is a no-op in CI without the secret, and the default `pnpm test` never includes
  these (separate `vitest.e2e.config.ts`).
- The Swift E2E tests **skip themselves** when no proxy is reachable on `:8788`, so `swift test` /
  `xcodebuild test` stay green offline (only the fast unit tests run).

Never commit a key. `omni.e2e.yaml` and `cloudflare/omni.e2e.worker.yaml` read `${OPENROUTER_API_KEY}`
from the environment; the Worker suite passes it to `wrangler dev --var`, so it is never written to a
`.dev.vars` (or any) file.
