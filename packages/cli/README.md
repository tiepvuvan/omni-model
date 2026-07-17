# omni-model

Deploy a self-hosted, **OpenAI-compatible AI proxy** — with client authentication, rate limits,
token budgets and model routing — in one command.

```sh
npx omni-model deploy
```

The wizard asks where to deploy, where rate-limit counters should live, how clients authenticate and
what the limits are; writes an `omni.yaml`; and ships it.

```
◆  Where do you want to deploy?
│  ● Cloudflare Workers   edge, forkless — downloads a prebuilt worker, no build
│  ○ Google Cloud Run     serverless container + Firestore
│  ○ Fly.io · Render · Docker (run locally)
◆  Where should rate-limit counters live?
│  ● Durable Object       exact counters, free-plan friendly
◆  Which upstream provider?    ● OpenAI ○ Anthropic ○ Gemini ○ OpenAI-compatible
◆  How should clients authenticate?
│  ◻ Firebase Auth  ◻ App Check  ◻ App Attest  ◻ DeviceCheck
◆  Requests per minute, per caller?   60
◆  Token budget per caller per day?   200000
```

## What it does

| Target | How it deploys |
| --- | --- |
| **Cloudflare Workers** | Downloads the **prebuilt worker** from a release and `wrangler deploy`s it — no fork, no clone, no build. |
| **Docker** | Runs the published `ghcr.io` image locally. |
| **Cloud Run · Fly.io · Render** | Generates the config and hands you the exact commands. |

## Your keys stay yours

The CLI **never writes a secret into your config.** Provider keys and the Apple `.p8` are emitted as
`${ENV}` references that the proxy resolves at startup, and the CLI tells you which ones to set:

```yaml
providers:
  openai:
    type: openai
    apiKey: ${OPENAI_API_KEY}   # set with: wrangler secret put OPENAI_API_KEY
```

So the generated `omni.yaml` is safe to commit, paste in an issue, or hand to a colleague.

## Commands

```sh
npx omni-model deploy          # configure + deploy (default)
npx omni-model init            # write omni.yaml and stop
npx omni-model deploy --yes    # accept defaults, skip confirmations
npx omni-model deploy -c my.yaml
```

Nothing is deployed without showing you the command first.

## Test it locally

The wizard itself deploys nothing — run it and inspect the config it writes:

```sh
pnpm build
node packages/cli/dist/index.js init        # wizard → writes omni.yaml, stops
```

`--dry-run` walks the whole deploy path and prints the command instead of running it:

```sh
node packages/cli/dist/index.js deploy --dry-run
```

To exercise the **Cloudflare** path before any release exists, build the artifacts a release would
ship and point the CLI at them:

```sh
pnpm --filter omni-model-cloudflare run artifacts   # → .artifacts/{worker.js,wrangler.jsonc}
OMNI_MODEL_ARTIFACTS="$PWD/.artifacts" \
  node packages/cli/dist/index.js deploy --dry-run
```

As a real command on your PATH:

```sh
cd packages/cli && npm link && omni-model init
```

Exactly what npm users will get:

```sh
cd packages/cli && npm pack                  # → omni-model-0.1.0.tgz
cd "$(mktemp -d)" && npm i /path/to/omni-model-0.1.0.tgz && npx omni-model --help
```

### Development overrides

| Variable | Effect |
| --- | --- |
| `OMNI_MODEL_ARTIFACTS` | Use a directory holding `worker.js` + `wrangler.jsonc` instead of downloading a release. |
| `OMNI_MODEL_IMAGE` | Use a specific container image (e.g. a local build). |
| `OMNI_MODEL_REPO` | Point at your fork. |

<!-- prettier-ignore -->
> **Note:** the published image tags `:latest` only on a version tag; pushes to `main` publish
> `:edge`. Before the first release, use `OMNI_MODEL_IMAGE=ghcr.io/tiepvuvan/omni-model:edge` for the
> Docker target.

## Learn more

Full configuration reference, security providers (Firebase Auth / App Check / App Attest /
DeviceCheck / custom JWT), CEL-based model routing and platform guides:
**https://github.com/tiepvuvan/omni-model**
