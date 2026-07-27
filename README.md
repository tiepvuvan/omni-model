# omni-model

A self-hosted, OpenAI-compatible AI proxy for your mobile and web apps. Your provider API keys
stay on your infrastructure — never inside an app binary. Clients authenticate with what they
already have (Firebase App Check, Apple App Attest / DeviceCheck, Firebase Auth, Clerk, AWS
Cognito, Supabase, or any JWT), and can add Cloudflare Turnstile, reCAPTCHA Enterprise, or Google Play Integrity as an
application-verification layer. You configure rate limits (request windows **and** token budgets) plus CEL-expression
model routing across OpenAI, Anthropic, Google Gemini and any OpenAI-compatible endpoint.

It ships as **one container image backed by PostgreSQL** — run it anywhere that runs containers.

```sh
docker run -p 8787:8787 --env-file omni.env ghcr.io/tiepvuvan/omni-model:latest
```

No fork, no clone, no build. Credentials stay in your platform's secret store.

The same image serves an **operator dashboard at `/admin`** — client authentication and model
routing, configured at runtime and applied to every replica within seconds, with no restart. Set
`OMNI_ADMIN_SECRET` to turn it on; see [the dashboard](docs/installation/dashboard.mdx).

## How it works

```text
Client (any OpenAI SDK)
        │  POST /v1/chat/completions        { "model": "smart", ... }
        ▼
┌───────────────────────────────────────────────┐
│  omni-model — your infrastructure             │
│   1. authenticate   App Check / App Attest /  │
│                     Firebase / Clerk / Cognito│
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
  challenge/register/assert flow built in), Apple DeviceCheck, Google Play Integrity, Cloudflare
  Turnstile, reCAPTCHA Enterprise, Firebase Auth, Clerk, AWS Cognito, Supabase Auth, or any custom
  JWT. Combine app verifiers with `mode: any` or `mode: all`.
- **Rate limits that understand LLMs** — fixed-window request limits *and* token budgets per
  user / device / IP / global / custom expression, with conditional rules
  (`when: 'has(user.claims.tier) && user.claims.tier == "free"'`). Fail-open on storage outages.
- **CEL model routing** — map client-facing aliases like `"smart"` to concrete provider+model by
  user tier, request shape or headers; fall back with per-model rules and a default provider.
- **One way to run it** — a single container image plus PostgreSQL. Scale to as many replicas as
  you like against one database; rate-limit counters stay exact because every increment is one
  atomic SQL statement.
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
OMNI_TARGET_TYPE=openai \
OMNI_TARGET_API_KEY='${OPENAI_API_KEY}' \
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
  -e OMNI_TARGET_TYPE=openai \
  -e 'OMNI_TARGET_API_KEY=${OPENAI_API_KEY}' \
  ghcr.io/tiepvuvan/omni-model:latest
```

Use the named `OMNI_STORAGE_*`, `OMNI_TARGET_*`, and `OMNI_SECURITY_*` variables for a
one-provider deployment. The [configuration reference](docs/reference/configuration.mdx) maps every
available setting. `OMNI_CONFIG_JSON`, named JSON blocks, and `OMNI__...` paths cover complex
multi-provider routing.

**Updating** is just `docker pull ghcr.io/tiepvuvan/omni-model:latest` and a restart — pin to a
version tag (`:1.2.3` / `:1.2`) for reproducible deploys, or `:edge` to track `main`. To build the
image yourself instead: `docker build -t omni-model .`.

### Production: Postgres

`memory` storage is fine for one process, but it loses everything on restart and shares nothing
between replicas. Point the container at PostgreSQL instead:

```sh
docker run -p 8787:8787 \
  -e DATABASE_URL=postgres://omni:secret@db:5432/omni \
  -e OMNI_STORAGE_TYPE=postgres \
  -e 'OMNI_STORAGE_POSTGRES_URL=${DATABASE_URL}' \
  ... \
  ghcr.io/tiepvuvan/omni-model:latest
```

The container creates its tables on first boot. Run as many replicas as you like against one
database — every counter increment is a single atomic SQL statement, so limits stay exact. See the
[Docker guide](docs/installation/docker.mdx) for Compose, health checks, and scaling notes.

## Configuration

Use `OMNI_CONFIG_JSON` for a complete configuration, named JSON blocks for providers/routing, or
`OMNI__...` variables for individual fields. This example combines all three:

```sh
OMNI_SECURITY_USER_AUTH_JSON='{"type":"firebase-auth","projectId":"${FIREBASE_PROJECT_ID}"}'
OMNI_SECURITY_APP_AUTH_JSON='{"providers":[{"type":"firebase-app-check","projectNumber":"${FIREBASE_PROJECT_NUMBER}"}]}'
OMNI_RATE_LIMITS_JSON='[
  {"name":"free-tier","when":"has(user.claims.tier) && user.claims.tier == \"free\"",
   "tokens":{"limit":30000,"window":"1d"}},
  {"name":"everyone","tokens":{"limit":150000,"window":"1d"}}
]'
OMNI_ROUTING_JSON='{
  "rules":[
    {"id":"smart","when":"request.model == \"smart\"",
     "target":{"type":"anthropic","apiKey":"${ANTHROPIC_API_KEY}","model":"claude-sonnet-4-5"}},
    {"id":"gpt-family","when":"request.model.startsWith(\"gpt-\")",
     "target":{"type":"openai","apiKey":"${OPENAI_API_KEY}"}},
    {"id":"everything-else","when":"true",
     "target":{"type":"openai","apiKey":"${OPENAI_API_KEY}"}}
  ]
}'
```

Each rule carries its own upstream — provider type, credentials and model — and the first match wins.
Swap which model backs `"smart"` from the dashboard or an environment variable; no app release
required.
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

| Type | Counter atomicity | Shared across instances | Survives restart | Use when |
| --- | --- | --- | --- | --- |
| `postgres` | exact (single-statement upsert) | yes | yes | production, at any number of replicas |
| `memory` | exact (single process) | no | no | local development |

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
testing conventions and PR checklist. `pnpm run ci` (lint + build + test) must be green.

## License

[MIT](LICENSE)
