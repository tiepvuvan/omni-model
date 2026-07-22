# omni-model

A self-hosted, OpenAI-compatible AI proxy for your mobile and web apps. Your provider API keys
stay on your infrastructure — never inside an app binary. Clients authenticate with what they
already have (Firebase App Check, Apple App Attest / DeviceCheck, Firebase Auth, Supabase, or any
JWT), and environment variables configure rate limits (request windows **and** token budgets) plus
CEL-expression model routing across OpenAI, Anthropic, Google Gemini and any OpenAI-compatible
endpoint. Deploy it to Cloudflare Workers or any container platform.

```sh
npx omni-model deploy
```

Picks your platform, storage, auth and limits, then ships it — no fork, no clone, no build. Runtime
configuration uses environment variables, so credentials stay in your platform's secret store.

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
OPENAI_API_KEY=sk-... \
OMNI_JWT_SECRET=dev-secret \
OMNI_STORAGE_TYPE=memory \
OMNI_SECURITY_JWT_ENABLED=true \
OMNI_SECURITY_JWT_SECRET='${OMNI_JWT_SECRET}' \
OMNI_PROVIDERS_DEFAULT_TYPE=openai \
OMNI_PROVIDERS_DEFAULT_API_KEY='${OPENAI_API_KEY}' \
node packages/node/dist/cli.js
```

Then talk to it with any OpenAI client:

```sh
curl http://localhost:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hello!"}]}'
```

### Docker (no clone required)

Pull the prebuilt multi-arch image from GHCR and pass environment variables — no fork, no build:

```sh
docker run -p 8787:8787 \
  -e OPENAI_API_KEY=sk-... \
  -e OMNI_JWT_SECRET=replace-with-a-long-random-secret \
  -e OMNI_STORAGE_TYPE=memory \
  -e OMNI_SECURITY_JWT_ENABLED=true \
  -e 'OMNI_SECURITY_JWT_SECRET=${OMNI_JWT_SECRET}' \
  -e OMNI_PROVIDERS_DEFAULT_TYPE=openai \
  -e 'OMNI_PROVIDERS_DEFAULT_API_KEY=${OPENAI_API_KEY}' \
  ghcr.io/tiepvuvan/omni-model:latest
```

Use the named `OMNI_STORAGE_*`, `OMNI_PROVIDERS_DEFAULT_*`, and `OMNI_SECURITY_*` variables for a
one-provider deployment. The [configuration reference](docs/reference/configuration.mdx) maps every
available setting. `OMNI_CONFIG_JSON`, named JSON blocks, and `OMNI__...` paths cover complex
multi-provider routing.

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
  Set your named `OMNI_STORAGE_*`, `OMNI_PROVIDERS_DEFAULT_*`, `OMNI_SECURITY_*`, or advanced JSON
  configuration variables and provider secrets in the
  Workers dashboard before the first request. Edit those variables to create a new configuration
  revision; no configuration file is bundled into the worker.
- **Cloud Run** — no fork. The button builds the repository, supplies a working OpenAI + JWT
  starter config, and asks for your OpenAI key and JWT signing secret. It intentionally starts at
  one instance with in-memory counters; follow the [Cloud Run guide](docs/installation/cloud-run.mdx)
  to move a production deployment to Firestore and Secret Manager.
- **Fly.io** — `fly launch --copy-config` (a `fly.toml` ships in the repo).

**Cloudflare without a fork.** Every release also ships a **prebuilt worker** — the edge counterpart
of the container image. Download it, supply config at runtime, done:

```sh
curl -LO https://github.com/tiepvuvan/omni-model/releases/latest/download/worker.js
curl -LO https://github.com/tiepvuvan/omni-model/releases/latest/download/wrangler.jsonc
npx wrangler deploy \
  --var OMNI_STORAGE_TYPE:durable-object \
  --var OMNI_PROVIDERS_DEFAULT_TYPE:openai
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

Use `OMNI_CONFIG_JSON` for a complete configuration, named JSON blocks for providers/routing, or
`OMNI__...` variables for individual fields. This example combines all three:

```sh
OMNI_SECURITY_PROVIDERS_JSON='[{"type":"firebase-app-check","projectNumber":"${FIREBASE_PROJECT_NUMBER}"}]'
OMNI_RATE_LIMITS_JSON='[
  {"name":"per-device-requests","key":"device","requests":{"limit":30,"window":"1m"}},
  {"name":"per-device-daily-tokens","key":"device","tokens":{"limit":150000,"window":"1d"}}
]'
OMNI_PROVIDERS_JSON='{
  "openai":{"type":"openai","apiKey":"${OPENAI_API_KEY}"},
  "anthropic":{"type":"anthropic","apiKey":"${ANTHROPIC_API_KEY}"}
}'
OMNI_ROUTING_JSON='{
  "routes":[{"name":"smart","when":"request.model == \"smart\"","provider":"anthropic","model":"claude-sonnet-4-5"}],
  "modelRules":[{"match":"request.model.startsWith(\"gpt-\")","provider":"openai"}],
  "defaultProvider":"openai"
}'
```

Swap which model backs `"smart"` by updating an environment variable—no app release required.
Every option is documented in [docs/reference/configuration.mdx](docs/reference/configuration.mdx).

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
