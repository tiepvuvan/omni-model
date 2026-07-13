# Deployment guide

omni-model runs anywhere a `fetch`-based HTTP handler runs: Cloudflare Workers at the edge, or the
Node server (`packages/node`) in any container platform. All platforms share the same YAML
configuration ([reference](./configuration.md)).

For every one-click path below: **fork the repository first**, commit your `omni.yaml`, and deploy
your fork. The deploy buttons in the README reference the canonical repository URL
(`https://github.com/omni-model/omni-model`) — point them at your fork so your config and secrets
stay yours.

## Container config resolution

The Docker image (used by Fly.io, Cloud Run, Render, and plain Docker) resolves its config at
startup, first match wins:

1. `OMNI_CONFIG` — inline YAML in an environment variable (handy for platforms without volumes).
2. `OMNI_CONFIG_PATH` — path to a YAML file you mounted or baked in.
3. `/app/omni.yaml` — an `omni.yaml` committed at the repo root when the image was built.

The server listens on `PORT` (default `8787`) and serves `GET /healthz` for health checks.

## Cloudflare Workers

The deployable worker lives in `apps/cloudflare` and is driven by the root `wrangler.jsonc`. It
registers the two Workers storage backends from `@omni-model/cloudflare` on top of the default
registry:

- `cloudflare-kv` (`KVStorageAdapter`) — cheap and global, but `increment` is a non-atomic
  read-modify-write on an eventually consistent store: rate-limit counts are **approximate**.
  Fine for best-effort limiting.
- `durable-object` (`OmniStorageDurableObject` + `DurableObjectStorageAdapter`) — each key is
  serialized by its own Durable Object, so counters are **exact**. Choose this when token budgets
  and quotas must not overshoot. Slightly higher latency/cost.

Steps:

1. Fork the repo and `pnpm install`.
2. Edit the worker config (`apps/cloudflare/omni.yaml`) — pick your storage backend and match the
   binding names in `wrangler.jsonc`:

   ```yaml
   storage:
     type: durable-object   # or: cloudflare-kv
     binding: OMNI_DO       # or: OMNI_KV
   ```

3. Put provider keys in Worker secrets (they are exposed to `${...}` interpolation as env vars):

   ```sh
   wrangler secret put OPENAI_API_KEY
   wrangler secret put ANTHROPIC_API_KEY
   ```

4. Deploy:

   ```sh
   cd apps/cloudflare
   pnpm run deploy      # wrangler deploy --config ../../wrangler.jsonc
   ```

   `pnpm run dev` starts a local `wrangler dev` session.

To change configuration without redeploying code, set the entire YAML document as the
`OMNI_CONFIG` secret — it overrides the bundled `omni.yaml`:

```sh
wrangler secret put OMNI_CONFIG < my-omni.yaml
```

## Fly.io

The repo ships a `fly.toml` (health check on `/healthz`, port 8787, scale-to-zero) and a
`Dockerfile`.

```sh
fly launch --copy-config     # first time; creates the app from fly.toml
fly secrets set OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-...
fly deploy
```

Config options:

- Commit an `omni.yaml` at the repo root before deploying — it is baked into the image.
- Or set the whole config as a secret: `fly secrets set OMNI_CONFIG="$(cat my-omni.yaml)"`.

For multiple machines, switch storage to `redis` (e.g. Upstash Redis via
`fly redis create`) or `postgres` so rate limits are shared:

```yaml
storage:
  type: redis
  url: ${REDIS_URL}
```

## Google Cloud Run

The "Run on Google Cloud" button uses `app.json` + the `Dockerfile`. Manual path:

```sh
gcloud run deploy omni-model \
  --source . \
  --port 8787 \
  --allow-unauthenticated \
  --set-env-vars OPENAI_API_KEY=sk-...
```

Cloud Run scales to many instances; use `redis` (Memorystore) or `postgres` (Cloud SQL) storage
so limits are enforced across all of them. Pass config via a committed `omni.yaml`, the
`OMNI_CONFIG` env var, or mount a file with `--update-secrets` and point `OMNI_CONFIG_PATH` at it.

## Render

`render.yaml` defines a Docker web service with the `/healthz` health check. Use the "Deploy to
Render" button on your fork, or create a Blueprint instance from the repo. Set
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` in the dashboard (they are declared
`sync: false`), and either commit an `omni.yaml` or set `OMNI_CONFIG`.

## Plain Docker / VPS

```sh
docker build -t omni-model .
docker run -p 8787:8787 \
  -e OPENAI_API_KEY=sk-... \
  -v ./omni.yaml:/app/omni.yaml:ro \
  omni-model
```

Anything that runs containers works the same way (AWS App Runner, Azure Container Apps, a
systemd unit on a VPS). One instance with `memory` storage is fine; more than one needs
`redis` or `postgres`.

## Bring your own server (embedding)

`createOmniApp` returns a plain [Hono](https://hono.dev) app, so you can mount it inside an
existing service, add middleware, or register custom providers/verifiers/storage backends via the
registry:

```ts
import { serve } from "@hono/node-server";
import { createDefaultRegistry, createOmniApp, parseConfig } from "@omni-model/core";
import { redisStorageFactory } from "@omni-model/storage-redis";
import { readFile } from "node:fs/promises";

const registry = createDefaultRegistry();
registry.storage.set(redisStorageFactory.type, redisStorageFactory);
// registry.providers.set("my-llm", myProviderFactory);  // your own ChatProvider

const config = parseConfig(await readFile("omni.yaml", "utf8"), process.env);
const app = await createOmniApp({ config, registry, env: process.env });

serve({ fetch: app.fetch, port: 8787 });
```

The same app object serves on Workers (`export default { fetch: app.fetch }`), Deno, or Bun. See
[CLAUDE.md](../CLAUDE.md) for the component contracts (`StorageAdapter`, `AuthVerifier`,
`ChatProvider`) and the extension recipe.
