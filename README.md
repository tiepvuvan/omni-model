# omni-model

A self-hosted, OpenAI-compatible AI proxy for your mobile and web apps. Your provider API keys
stay on your infrastructure — never inside an app binary. Clients authenticate with what they
already have (Firebase App Check, Apple App Attest / DeviceCheck, Firebase Auth, Supabase, or any
JWT), and one YAML file configures rate limits (request windows **and** token budgets) plus
CEL-expression model routing across OpenAI, Anthropic, Google Gemini and any OpenAI-compatible
endpoint. Deploy it to Cloudflare Workers or any container platform.

```sh
npx omni-model deploy
```

Picks your platform, storage, auth and limits, writes an `omni.yaml`, and ships it — no fork, no
clone, no build. Your API keys never enter the config: it emits `${ENV}` references and tells you
which secrets to set.

## How it works

```text
Client (any OpenAI SDK)
        │  POST /v1/chat/completions        { "model": "smart", ... }
        ▼
┌───────────────────────────────────────────────┐
│  omni-model — your infrastructure             │
│   1. authenticate   App Check / App Attest /  │
│                     Firebase Auth / Supabase /│
│                     JWT                       │
│   2. rate limit     request windows +         │
│                     token budgets             │
│   3. route          CEL rules over model,     │
│                     user claims, headers, ... │
└───────────────┬───────────────────────────────┘
                │  translated on the fly
      ┌─────────┼─────────────┬──────────────────────────┐
      ▼         ▼             ▼                          ▼
   OpenAI   Anthropic   Google Gemini   any OpenAI-compatible endpoint
```

Point any OpenAI SDK at your proxy URL and keep using the OpenAI wire format everywhere —
requests to Anthropic and Gemini are translated automatically, both directions, streaming
included.

> 📖 **Documentation** — installation, security, client integrations, and the full config
> reference live in [`docs/`](docs/) as a [Mintlify](https://mintlify.com) site
> (`docs/docs.json`). Run `npx mint dev` inside `docs/` to preview locally.

## Features

- **OpenAI-compatible surface** — `/v1/chat/completions` (streaming SSE included), `/v1/models`,
  `/v1/embeddings`; OpenAI-style error bodies. Existing SDKs work unchanged.
- **Client attestation, not shared secrets** — Firebase App Check, Apple App Attest (full
  challenge/register/assert flow built in), Apple DeviceCheck, Firebase Auth, Supabase Auth, or
  any custom JWT. Combine verifiers with `mode: any` or `mode: all`.
- **Rate limits that understand LLMs** — fixed-window request limits *and* token budgets per
  user / device / IP / global / custom expression, with conditional rules
  (`when: 'has(user.claims.tier) && user.claims.tier == "free"'`). Fail-open on storage outages.
- **CEL model routing** — map client-facing aliases like `"smart"` to concrete provider+model by
  user tier, request shape or headers; fall back with per-model rules and a default provider.
- **Runs anywhere** — Cloudflare Workers (KV or Durable Object storage), Docker, Fly.io, Cloud
  Run, Render, bare Node. Redis and Postgres storage for multi-instance deployments.
- **Extensible** — auth verifiers, providers, and storage backends are pluggable factories in a
  registry; add your own without forking core.

## Quick start

### Local

```sh
pnpm install
pnpm build
OPENAI_API_KEY=sk-... node packages/node/dist/cli.js --config examples/omni-minimal.yaml
```

Then talk to it with any OpenAI client:

```sh
curl http://localhost:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hello!"}]}'
```

### Docker (no clone required)

Pull the prebuilt multi-arch image from GHCR and pass your config — no fork, no build:

```sh
docker run -p 8787:8787 \
  -e OPENAI_API_KEY=sk-... \
  -e OMNI_CONFIG="$(cat omni.yaml)" \
  ghcr.io/tiepvuvan/omni-model:latest
```

Or mount the config file instead of inlining it:

```sh
docker run -p 8787:8787 \
  -e OPENAI_API_KEY=sk-... \
  -v ./omni.yaml:/app/omni.yaml:ro \
  ghcr.io/tiepvuvan/omni-model:latest
```

**Updating** is just `docker pull ghcr.io/tiepvuvan/omni-model:latest` and a restart — pin to a
version tag (`:1.2.3` / `:1.2`) for reproducible deploys, or `:edge` to track `main`. To build the
image yourself instead: `docker build -t omni-model .`.

### One-click deploys

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/tiepvuvan/omni-model)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tiepvuvan/omni-model)
[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run/?git_repo=https://github.com/tiepvuvan/omni-model)

- **Render** — no fork. The [`render.yaml`](render.yaml) Blueprint runs the prebuilt GHCR image,
  provisions a managed Key Value (Redis) datastore for rate limits, and prompts you for your
  provider API keys.
- **Cloudflare Workers** — the button forks the repo into your account (Workers bindings + secrets
  live there), compiles the workspace packages and provisions the `OMNI_DO` Durable Object for you.
  One step is left, and the proxy tells you so: until you run
  `wrangler secret put OPENAI_API_KEY`, every request answers `missing environment variable
  "OPENAI_API_KEY"` — set it and you're live. Edit `apps/cloudflare/omni.yaml` to change the
  config (or set the `OMNI_CONFIG` secret to reconfigure without a rebuild).
- **Cloud Run** — no fork; paste your config into the `OMNI_CONFIG` prompt.
- **Fly.io** — `fly launch --copy-config` (a `fly.toml` ships in the repo).

**Cloudflare without a fork.** Every release also ships a **prebuilt worker** — the edge counterpart
of the container image. Download it, supply config at runtime, done:

```sh
curl -LO https://github.com/tiepvuvan/omni-model/releases/latest/download/worker.js
curl -LO https://github.com/tiepvuvan/omni-model/releases/latest/download/wrangler.jsonc
npx wrangler deploy --var OMNI_CONFIG:"$(cat omni.yaml)"
```

No fork, no clone, no build. You trade push-to-deploy CI for a `curl` + redeploy on updates.

Full platform walkthroughs — including Cloudflare KV vs Durable Object storage — in
the [installation guides](docs/installation/cloudflare.mdx).

### Serverless on Firebase (no backend)

For mobile/web apps with no server at all, install the **Firebase Extension**
(`extensions/omni-model-proxy`): your app calls an OpenAI-compatible **Callable Function**, and the
Firebase SDKs attach the caller's **Firebase Auth** and **App Check** tokens automatically —
omni-model maps them to identities and enforces per-user limits in **Firestore**. Streaming works
via the callable streaming API. See [docs/installation/firebase.mdx](docs/installation/firebase.mdx).

```js
const chat = httpsCallable(getFunctions(), "ext-omni-model-proxy-chat");
const { stream, data } = await chat.stream({ model: "gpt-4o-mini", messages });
for await (const c of stream) render(c.choices?.[0]?.delta?.content ?? "");
```

## Configuration

One YAML file. The interesting parts:

```yaml
version: 1

security:
  providers:
    # Only authentic installs of your app get through.
    - type: firebase-app-check
      projectNumber: "1234567890"

rateLimits:
  - name: per-device-requests
    key: device
    requests: { limit: 30, window: 1m }
  - name: per-device-daily-tokens
    key: device
    tokens: { limit: 150000, window: 1d }

providers:
  openai:
    type: openai
    apiKey: ${OPENAI_API_KEY}
  anthropic:
    type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}

routing:
  routes:
    # The app asks for "smart"; you decide what that means today.
    - name: smart
      when: 'request.model == "smart"'
      provider: anthropic
      model: claude-sonnet-4-5
  modelRules:
    - match: 'request.model.startsWith("gpt-")'
      provider: openai
  defaultProvider: openai
```

Swap which model backs `"smart"` in config — no app release required. Every option (all six
auth verifier types, the full CEL expression context, storage backends, provider translation
notes) is documented in [docs/reference/configuration.mdx](docs/reference/configuration.mdx), with a complete annotated
example in [examples/omni.yaml](examples/omni.yaml).

## Using it from your app

The proxy speaks the OpenAI protocol, so every OpenAI SDK works — only the base URL and the auth
headers change.

**JavaScript / TypeScript** (Firebase App Check):

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://ai.example.com/v1",
  apiKey: "unused", // the proxy holds the real provider keys
  defaultHeaders: { "X-Firebase-AppCheck": await getAppCheckToken() },
});

const completion = await client.chat.completions.create({
  model: "smart",
  messages: [{ role: "user", content: "Hello!" }],
});
```

**Python** (Firebase Auth / Supabase / custom JWT — the SDK's `api_key` becomes the
`Authorization: Bearer` token your verifier checks):

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://ai.example.com/v1",
    api_key=user_id_token,  # Firebase ID token, Supabase access token, or your JWT
)

completion = client.chat.completions.create(
    model="gemini-2.0-flash",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

**iOS with App Attest** — after the one-time key registration
(`POST /auth/app-attest/challenge` + `POST /auth/app-attest/register`, see
[the protocol](docs/security/app-attest.mdx)), each request carries three headers:

```sh
curl https://ai.example.com/v1/chat/completions \
  -H "content-type: application/json" \
  -H "x-appattest-keyid: $KEY_ID" \
  -H "x-appattest-assertion: $ASSERTION" \
  -H "x-appattest-challenge: $CHALLENGE" \
  -d '{"model": "smart", "messages": [{"role": "user", "content": "Hello!"}]}'
```

## Storage backends

Rate-limit counters, token budgets and attestation keys live in pluggable storage:

| Type | Counter atomicity | Shared across instances | Use when |
| --- | --- | --- | --- |
| `memory` | exact (single process) | no | local dev; a single long-lived instance |
| `cloudflare-kv` | approximate (non-atomic RMW) | yes (eventually consistent) | Workers; best-effort limits are enough |
| `durable-object` | exact (serialized per key) | yes | Workers; limits and budgets must be exact |
| `redis` | exact (server-side Lua) | yes | containers with more than one instance |
| `postgres` | exact (single-statement upsert) | yes | you already run Postgres and want no new infra |
| `firestore` | exact (transaction, per-user keys) | yes | serverless on Firebase / Cloud Functions |

Details and options per backend in [docs/reference/configuration.mdx](docs/reference/configuration.mdx).

## Extending

Everything pluggable — auth verifiers, model providers, storage backends — goes through a
registry of factories keyed by `type`. Add a component by implementing its contract and
registering it; core never needs a fork:

```ts
const registry = createDefaultRegistry();
registry.providers.set("my-llm", myProviderFactory);
const app = await createOmniApp({ config, registry });
```

The contracts (`AuthVerifier`, `ChatProvider`, `StorageAdapter`) and the extension recipe are
documented in [CLAUDE.md](CLAUDE.md); an embedding example is in
[docs/reference/configuration.mdx](docs/reference/configuration.mdx).

## Contributing

See [CLAUDE.md](CLAUDE.md) — the contributor guide covers the architecture rules, toolchain,
testing conventions and PR checklist. `pnpm ci` (lint + build + test) must be green.

## License

[MIT](LICENSE)
