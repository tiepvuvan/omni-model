# Configuration reference

omni-model is configured with a single YAML file. Every option below is validated at startup —
unknown keys, bad types, unresolvable expressions and references to unknown providers all throw a
`ConfigError` before the server accepts a single request, never mid-request.

A complete annotated example lives at [`examples/omni.yaml`](../examples/omni.yaml); the smallest
useful config at [`examples/omni-minimal.yaml`](../examples/omni-minimal.yaml).

Top-level keys:

```yaml
version: 1        # config format version (only 1 exists; may be omitted)
server: {}        # CORS + log level
storage: {}       # where counters, budgets and attestation keys live
security: {}      # client authentication
rateLimits: []    # request windows + token budgets
providers: {}     # upstream model providers, keyed by your own ids
routing: {}       # which provider serves which request
```

All string values support [environment variable interpolation](#environment-variable-interpolation).

---

## `version`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | `1` | `1` | Config format version. Only `1` is valid. |

## `server`

```yaml
server:
  logLevel: info
  cors:
    allowOrigins: ["https://app.example.com"]
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `logLevel` | `debug` \| `info` \| `warn` \| `error` \| `silent` | `info` | Level for the built-in console logger. |
| `cors` | object | _(none)_ | When present, CORS middleware is applied to every route. When absent, no CORS headers are sent. |

`server.cors` options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `allowOrigins` | `string[]` | `["*"]` | Allowed origins. If the list contains `"*"`, all origins are allowed. |
| `allowMethods` | `string[]` | library default | Allowed methods for preflight responses. |
| `allowHeaders` | `string[]` | library default | Allowed request headers. |
| `exposeHeaders` | `string[]` | _(none)_ | Response headers exposed to browser scripts. |
| `maxAge` | positive integer | _(none)_ | Preflight cache lifetime in seconds. |
| `credentials` | boolean | _(none)_ | Sets `Access-Control-Allow-Credentials`. |

## `storage`

Storage holds rate-limit counters, token budgets, App Attest challenges/keys and the DeviceCheck
validation cache. The block is discriminated by `type`; each backend validates its own options.

```yaml
storage:
  type: memory
```

Defaults to `{ type: memory }` when omitted.

### `type: memory` (built in)

No options. In-process storage: state is neither shared across instances nor persisted across
restarts. `increment` is exact within the single process. Use for local development or a single
long-lived instance where approximate limits after a restart are acceptable.

### `type: redis` (`@omni-model/storage-redis`)

```yaml
storage:
  type: redis
  url: ${REDIS_URL}
  keyPrefix: "omni:"
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string | required | A `redis://` or `rediss://` URL. |
| `keyPrefix` | string | `"omni:"` | Prefix applied to every key so several apps can share one Redis. |

Atomicity: increments run as a single server-side Lua script (`INCRBY` + conditional `EXPIRE`), so
counters are **exact under concurrency** across any number of proxy instances. Sub-second TTLs
round up to one second.

Registered by the Node server entry (and available to embedders); it is not part of
`createDefaultRegistry()`.

### `type: postgres` (`@omni-model/storage-postgres`)

```yaml
storage:
  type: postgres
  url: ${DATABASE_URL}
  table: omni_kv
  migrate: true
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string | required | Postgres connection string. |
| `table` | string | `omni_kv` | Backing table name; must match `[a-zA-Z_][a-zA-Z0-9_]*`. |
| `migrate` | boolean | `true` | Create the table and expiry index at startup. Disable if you manage schema yourself. |

Atomicity: every operation, including `increment`, is a single SQL statement (an upsert that
serializes on the row), so counters are **exact under concurrency** across instances. Expired rows
are filtered from reads immediately and physically swept in the background.

Registered by the Node server entry, not by `createDefaultRegistry()`.

### `type: cloudflare-kv` (`@omni-model/cloudflare`)

```yaml
storage:
  type: cloudflare-kv
  binding: OMNI_KV
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `binding` | string | worker-defined | Name of the KV namespace binding in your wrangler config. Consumed by the worker entry. |

Atomicity: `increment` is a **non-atomic** read-modify-write on an eventually consistent store.
Concurrent increments from different isolates or edge locations can lose updates — counts are
approximate. Good enough for best-effort rate limiting, **not** for strict quotas; use
`durable-object` when limits must be exact. KV also enforces a minimum TTL of 60 seconds, so
shorter windows are clamped up, and every counter write re-applies the window TTL (busy windows
expire later, erring on the side of stricter limiting).

### `type: durable-object` (`@omni-model/cloudflare`)

```yaml
storage:
  type: durable-object
  binding: OMNI_DO
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `binding` | string | worker-defined | Name of the Durable Object namespace binding in your wrangler config. Consumed by the worker entry. |
| `name` | string | _(none)_ | Logical store name prefixed onto every object name, so several deployments can share one namespace. |

Atomicity: every storage key routes to its own Durable Object, and the runtime serializes
operations per object — counters are **exact**. Slightly higher latency and cost than KV; the right
choice when token budgets must not overshoot.

## `security`

Client authentication for everything under `/v1/*`. `/healthz` and verifier-contributed routes
(such as `/auth/app-attest/*`) are never behind authentication.

```yaml
security:
  mode: any
  publicPaths: []
  providers:
    - type: firebase-app-check
      projectNumber: "1234567890"
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `any` \| `all` | `any` | How multiple verifiers combine (below). |
| `publicPaths` | `string[]` | `[]` | Paths that bypass authentication: exact match, or prefix match when the pattern ends with `*` (e.g. `/v1/models*`). |
| `providers` | array | `[]` | Verifier blocks, discriminated by `type`. |

With **no providers configured**, the proxy accepts unauthenticated requests on `/v1/*` and logs a
warning at startup.

Each verifier inspects the request for its own credential and returns one of three outcomes:
*absent* (its credential is not on the request), *accepted*, or *rejected*
(present but invalid).

**`mode: any`** — verifiers are consulted in config order:

- The first verifier that **accepts** wins; its identity is attached to the request.
- A verifier whose credential is **absent** is skipped and the next one is tried.
- A **rejection** is remembered but the chain continues; the request fails with the *first*
  rejection's reason unless a later verifier positively accepts it.
- If every verifier reports its credential absent, the request is rejected with
  `authentication required` (HTTP 401).

**`mode: all`** — every configured verifier must accept:

- A missing credential fails with `credential missing for <name>` (401).
- Any rejection fails with that verifier's reason (401).
- The accepted identities are merged: the first defined `userId`/`deviceId` (in config order)
  wins; `provider` is taken from the identity that supplied `userId` (falling back to the first);
  the first identity's claims are flattened at the top level of `user.claims`, then every
  verifier's claims are additionally namespaced under its `name`
  (`user.claims[verifierName]`). A namespaced key overwrites a same-named top-level claim, so
  pick verifier names that do not collide with claim names.

Every verifier block accepts an optional `name` (defaults to its `type`) used in error messages,
claim namespacing, and logs.

### `type: jwt`

Verifies arbitrary JWTs against a JWKS endpoint, a shared secret (HS\*) or a pinned public key.
Token claims are exposed to CEL rules as `user.claims`.

```yaml
- type: jwt
  jwksUrl: https://auth.example.com/.well-known/jwks.json
  issuer: https://auth.example.com
  audience: omni-model
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `header` | string | `authorization` | Header carrying the token. |
| `scheme` | `bearer` \| `none` | `bearer` | `bearer` strips a `Bearer ` prefix; `none` uses the raw header value. |
| `jwksUrl` | URL | — | Remote JWKS endpoint for asymmetric keys. |
| `secret` | string | — | Shared secret for HS\* algorithms. |
| `publicKey` | string | — | SPKI PEM public key; requires `algorithms` with exactly one entry. |
| `algorithms` | `string[]` | _(any)_ | Allowed JWS algorithms, e.g. `["RS256"]`. |
| `issuer` | string | _(unchecked)_ | Expected `iss` claim. |
| `audience` | string \| `string[]` | _(unchecked)_ | Expected `aud` claim. |
| `userIdClaim` | string | `sub` | Claim mapped to `user.id`. |
| `deviceIdClaim` | string | _(none)_ | Claim mapped to `device.id`. |
| `clockToleranceSeconds` | integer ≥ 0 | `60` | Allowed clock skew. |

Exactly **one** of `jwksUrl`, `secret` or `publicKey` must be provided.

### `type: firebase-auth`

Verifies Firebase Authentication ID tokens (RS256) against Google's JWKS. The Firebase uid becomes
`user.id`. Clients send `Authorization: Bearer <ID token>`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `projectId` | string | required | Firebase project id, e.g. `my-app-12345`. |
| `header` | string | `authorization` | Header carrying the ID token as `Bearer <token>`. |
| `clockToleranceSeconds` | integer ≥ 0 | `60` | Allowed clock skew. |

### `type: supabase`

Verifies Supabase Auth access tokens, either with the project's legacy shared JWT secret (HS256)
or against the project's JWKS. `sub` becomes `user.id`; Supabase claims like `role` and
`app_metadata` are available under `user.claims`.

```yaml
- type: supabase
  url: https://abcdefgh.supabase.co
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | URL | — | Supabase project URL; used to derive the JWKS endpoint and issuer. |
| `jwtSecret` | string | — | Legacy shared JWT secret (HS256). |
| `jwksUrl` | URL | `<url>/auth/v1/.well-known/jwks.json` | Explicit JWKS endpoint. |
| `issuer` | string | `<url>/auth/v1` | Expected issuer. |
| `audience` | string \| `string[]` | `authenticated` | Expected audience. |
| `header` | string | `authorization` | Header carrying the token as `Bearer <token>`. |
| `clockToleranceSeconds` | integer ≥ 0 | `60` | Allowed clock skew. |

Provide `jwtSecret` **or** `jwksUrl` (not both); with neither, `url` is required to derive the
JWKS endpoint.

### `type: firebase-app-check`

Verifies Firebase App Check tokens, attesting that requests come from an authentic instance of
your app (iOS, Android or web). App Check tokens carry no user, so the Firebase app id becomes
`device.id` and `user.id` stays unset.

```yaml
- type: firebase-app-check
  projectNumber: "1234567890"
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `projectNumber` | string | required | The **numeric** Firebase project number (not the project id). |
| `appIds` | `string[]` | _(any app)_ | Allowlist of Firebase app ids (matched against the token `sub`). |
| `header` | string | `x-firebase-appcheck` | Header carrying the raw App Check token (no `Bearer` prefix). |
| `clockToleranceSeconds` | integer ≥ 0 | `60` | Allowed clock skew. |

Clients: fetch a token with the Firebase App Check SDK and send it as `X-Firebase-AppCheck` on
every request.

### `type: apple-device-check`

Verifies Apple DeviceCheck device tokens by calling Apple's `validate_device_token` endpoint,
authenticated with an ES256 JWT signed by your DeviceCheck key. Successful validations are cached
in storage for `cacheTtl` so hot devices don't hit Apple on every request.

```yaml
- type: apple-device-check
  teamId: ABCDE12345
  keyId: FGHIJ67890
  privateKey: ${APPLE_DEVICECHECK_KEY}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `teamId` | string | required | Apple Developer team identifier. |
| `keyId` | string | required | Key id of the DeviceCheck `.p8` key. |
| `privateKey` | string | required | PKCS8 PEM contents of the `.p8` key (must contain `-----BEGIN PRIVATE KEY-----`), typically `${APPLE_DEVICECHECK_KEY}`. |
| `development` | boolean | `false` | Use Apple's development DeviceCheck endpoint. |
| `header` | string | `x-apple-device-token` | Header carrying the device token. |
| `cacheTtl` | duration | `5m` | How long a validated token is cached. |

Apple 4xx responses reject the request with Apple's error text; network failures and Apple 5xx map
to a generic "device check unavailable" rejection (the raw token is never logged or echoed).

### `type: apple-app-attest`

Verifies Apple App Attest hardware-backed assertions. This is the strongest iOS attestation: each
device registers a Secure Enclave key once, then signs every API request.

```yaml
- type: apple-app-attest
  teamId: ABCDE12345
  bundleId: com.example.app
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `teamId` | string | required | Apple Developer team id; the App ID is `<teamId>.<bundleId>`. |
| `bundleId` | string | required | Your app's bundle identifier. |
| `environment` | `production` \| `development` | `production` | Which App Attest environment produced the keys (checked via the attestation AAGUID). |
| `challengeTtl` | duration | `5m` | Lifetime of issued challenges. |
| `keyIdHeader` | string | `x-appattest-keyid` | Per-request header carrying the key id. |
| `assertionHeader` | string | `x-appattest-assertion` | Per-request header carrying the assertion. |
| `challengeHeader` | string | `x-appattest-challenge` | Per-request header carrying the challenge. |
| `rootCaPem` | string | Apple's published root | Trust-anchor override (for tests). |

The verifier contributes two public endpoints (mounted outside `/v1`, no auth required):

**Client protocol**

1. **Get a challenge** — `POST /auth/app-attest/challenge` (empty body). Response:

   ```json
   { "challenge": "base64url-string" }
   ```

   Challenges are single-use and expire after `challengeTtl`.

2. **Register the key** (once per install) — generate a key with
   `DCAppAttestService.generateKey()`, attest it with
   `attestKey(keyId, clientDataHash:)` where `clientDataHash` is the **SHA-256 of the UTF-8
   challenge string**, then `POST /auth/app-attest/register` with:

   ```json
   {
     "keyId": "<base64 key id from generateKey>",
     "attestation": "<base64 CBOR attestation object>",
     "challenge": "<the challenge string from step 1>"
   }
   ```

   The server verifies the certificate chain to Apple's App Attestation Root CA, the nonce
   binding, key id, App ID hash, environment AAGUID and credential id, then stores the public key.
   Response: `{ "registered": true }`.

3. **Sign each API request** — fetch a fresh challenge (step 1), call
   `generateAssertion(keyId, clientDataHash:)` with `clientDataHash` again the SHA-256 of the
   UTF-8 challenge string, and send three headers with the API request:

   | Header | Value |
   | --- | --- |
   | `X-AppAttest-KeyId` | the base64 key id |
   | `X-AppAttest-Assertion` | the base64-encoded CBOR assertion |
   | `X-AppAttest-Challenge` | the challenge string |

   The server verifies the signature with the registered key, checks the App ID hash, requires
   the sign counter to strictly increase (blocks replay), and deletes the challenge (single-use).
   The key id becomes `device.id`.

## `rateLimits`

An ordered list of rules; **every applicable rule is enforced** (they are not first-match). Each
rule needs at least one of `requests` or `tokens`.

```yaml
rateLimits:
  - name: per-user-requests
    key: user
    requests: { limit: 60, window: 1m }
  - name: per-user-daily-tokens
    key: user
    tokens: { limit: 200000, window: 1d }
  - name: free-tier
    when: 'has(user.claims.tier) && user.claims.tier == "free"'
    key: user
    requests: { limit: 10, window: 1m }
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | required | Unique rule name. Names isolate counter keyspaces; **duplicates are rejected at startup**. |
| `when` | CEL expression | _(always applies)_ | Rule applies only when this evaluates to exactly `true` (see [the CEL context](#the-cel-expression-context)). An expression that throws means the rule does not apply to that request. |
| `key` | `user` \| `device` \| `ip` \| `global` \| `expression` | `user` | What the counter is scoped to. |
| `keyExpression` | CEL expression | — | Required when `key: expression`; its result (stringified) is the counter key. If it throws, the rule is skipped for that request. |
| `requests` | `{ limit, window }` | _(none)_ | Max requests per window. `limit` is a positive integer; `window` a duration like `30s`, `5m`, `1h`, `1d`. |
| `tokens` | `{ limit, window }` | _(none)_ | Max total tokens (prompt + completion) per window. |

**Key kinds and fallback chains** — when the preferred identity attribute is missing, the key
falls back so unauthenticated traffic is still limited:

| `key` | Counter scoped to |
| --- | --- |
| `user` | `user.id` → `device.id` → client IP → `"anonymous"` |
| `device` | `device.id` → client IP → `"anonymous"` |
| `ip` | client IP → `"unknown"` |
| `global` | one shared counter for all traffic |
| `expression` | the stringified result of `keyExpression` |

**Semantics:**

- **Fixed windows.** Windows are aligned to the epoch (`floor(now / window) * window`), not
  sliding. A violation returns HTTP 429 with `Retry-After` (seconds until the window rolls),
  `x-ratelimit-limit` and `x-ratelimit-rule` headers, and an OpenAI-style error body.
- **Token budgets consume after the response.** Budgets are pre-checked read-only before the
  request runs; actual usage is recorded *after* the response from the provider's reported
  `usage` (for streams, from the final usage chunk), in the background. A budget can therefore
  overshoot by the in-flight requests' tokens — pair a token budget with a `requests` window to
  bound the overshoot. A request rejected on an exhausted budget does not consume request-window
  slots.
- **Rejected requests still count.** Every applicable request window is incremented even when an
  earlier rule already rejected the request — hammering an exhausted limit never earns extra
  throughput.
- **Fail-open.** If storage cannot be read or written, the affected rule passes and the failure
  is logged at error level. A Redis outage must not take your API down.

## `providers`

A map from **your own provider ids** (the names routing refers to) to provider blocks
discriminated by `type`. The same type may appear multiple times under different ids.

### `type: openai`

Passthrough to the OpenAI API. Requests and stream bytes are forwarded unmodified.

```yaml
providers:
  openai:
    type: openai
    apiKey: ${OPENAI_API_KEY}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | string | required | OpenAI API key. |
| `baseUrl` | URL | `https://api.openai.com/v1` | API base URL. |
| `organization` | string | _(none)_ | Sent as `OpenAI-Organization`. |
| `headers` | map | `{}` | Extra headers merged over the computed ones. |
| `models` | `string[]` | `[]` | Static model list served when the upstream `/models` call fails. |
| `includeStreamUsage` | boolean | `true` | Inject `stream_options.include_usage` into streaming requests so the final chunk carries usage for token budgets. A client-sent `include_usage: false` wins. |

### `type: openai-compatible`

Any endpoint speaking the OpenAI wire format: Groq, Together, Mistral, OpenRouter, Azure OpenAI,
vLLM, Ollama, ...

```yaml
providers:
  groq:
    type: openai-compatible
    baseUrl: https://api.groq.com/openai/v1
    apiKey: ${GROQ_API_KEY}
```

Same options as `type: openai`, except:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `baseUrl` | URL | required | No sensible default exists. |
| `apiKey` | string | _(none)_ | Optional — local servers (Ollama, vLLM) often need none. |

### `type: anthropic`

Translation provider for the Anthropic Messages API: clients keep speaking OpenAI chat
completions; requests and responses (streaming included) are converted in both directions.

```yaml
providers:
  anthropic:
    type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | string | required | Anthropic API key (sent as `x-api-key`). |
| `baseUrl` | string | `https://api.anthropic.com` | API base URL. |
| `version` | string | `2023-06-01` | Sent as the `anthropic-version` header. |
| `maxTokensDefault` | positive integer | `4096` | Anthropic requires `max_tokens`; used when the client sends neither `max_tokens` nor `max_completion_tokens`. |

Translation notes:

- `system`/`developer` messages become the Anthropic `system` prompt; consecutive same-role
  messages are merged (Anthropic rejects them).
- `temperature` is **clamped to 0..1** (OpenAI allows 0..2).
- `stop` → `stop_sequences`; `user` → `metadata.user_id`.
- Tools map to Anthropic tools; `tool_choice: "auto" | "required" | {function}` map to
  `auto | any | tool`; `tool_choice: "none"` drops the tools entirely (Anthropic has no "none").
- Image parts: `data:` URLs become base64 blocks, `http(s)` URLs become URL blocks.
- Stop reasons map to OpenAI finish reasons (`max_tokens` → `length`, `tool_use` → `tool_calls`,
  `refusal` → `content_filter`, everything else → `stop`).
- **`n > 1` is rejected** with a 400.
- Streaming usage is emitted as a final usage-only chunk when the client sends
  `stream_options: { include_usage: true }` (and is always captured internally for token budgets).
- No embeddings support: `/v1/embeddings` routed here returns 404 `unsupported_endpoint`.

### `type: google`

Translation provider for the Google Gemini API (`generateContent`, streaming included).

```yaml
providers:
  google:
    type: google
    apiKey: ${GEMINI_API_KEY}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | string | required | Gemini API key (sent as the `x-goog-api-key` header, never in the URL). |
| `baseUrl` | string | `https://generativelanguage.googleapis.com/v1beta` | API base URL. |

Translation notes:

- `system`/`developer` messages become `systemInstruction`; consecutive same-role messages are
  merged into one turn (Gemini requires alternating user/model turns).
- A `models/` prefix on the model name is stripped, so `models/gemini-2.0-flash` and
  `gemini-2.0-flash` both work.
- Tool schemas are sanitized: `$schema` and `additionalProperties` are stripped, and nullable
  type unions (`type: ["string", "null"]`) are rewritten to `type: "string", nullable: true`.
- `response_format: json_object | json_schema` map to `responseMimeType: application/json`
  (+ `responseSchema`).
- **`n > 1` is rejected** with a 400.
- Safety blocks surface as `finish_reason: "content_filter"`, not as errors.
- Embeddings are supported for string inputs (`embedContent` / `batchEmbedContents`); token-array
  inputs are rejected with a 400.

## `routing`

Decides which provider (and which upstream model) serves each request.

```yaml
routing:
  routes:
    - name: smart-for-pro
      when: 'request.model == "smart" && has(user.claims.tier) && user.claims.tier == "pro"'
      provider: anthropic
      model: claude-sonnet-4-5
    - name: smart-default
      when: 'request.model == "smart"'
      provider: openai
      model: gpt-4o-mini
  modelRules:
    - match: 'request.model.startsWith("claude-")'
      provider: anthropic
    - match: 'request.model.startsWith("gemini-")'
      provider: google
  defaultProvider: openai
```

Evaluation order — **first match wins**:

1. `routes`, in order. A route matches when its `when` expression evaluates to exactly `true`.
   `model` (optional) overrides the upstream model; without it the client-requested model is
   kept.
2. `modelRules`, in order — the same mechanics with `match` instead of `when`; intended as
   fallback "who owns this model name" mapping.
3. `defaultProvider` — used verbatim with the client-requested model.

If nothing matches, the request fails with a 404 `model_not_found` error (OpenAI-style).

| `routes[]` option | Type | Description |
| --- | --- | --- |
| `name` | string | Route name (shown in logs). Required. |
| `when` | CEL expression | Required; must evaluate to exactly `true` to match. |
| `provider` | string | A key of `providers`. Checked at startup. Required. |
| `model` | string | Upstream model override. Optional. |

| `modelRules[]` option | Type | Description |
| --- | --- | --- |
| `match` | CEL expression | Required. |
| `provider` | string | A key of `providers`. Checked at startup. Required. |
| `model` | string | Upstream model override. Optional. |

Expression failure policy: a condition that **throws** at evaluation time (e.g. a missing map
key) or returns a **non-boolean** counts as *no match* — one bad expression cannot take the proxy
down. Non-boolean results additionally log a warning (once per rule) as a config smell.

### The CEL expression context

All `when`, `match` and `keyExpression` fields are
[CEL](https://github.com/google/cel-spec) expressions evaluated against these variables:

| Variable | Type | Description | Example expression |
| --- | --- | --- | --- |
| `request.model` | string | The client-requested model (`""` if absent). | `request.model == "smart"` |
| `request.stream` | bool | Whether the client requested streaming. | `!request.stream` |
| `request.messageCount` | int | Number of entries in `messages`. | `request.messageCount > 20` |
| `request.maxTokens` | number \| null | `max_completion_tokens` ?? `max_tokens`. | `request.maxTokens != null && request.maxTokens > 4096` |
| `request.temperature` | number \| null | The request temperature. | `request.temperature != null && request.temperature > 1.0` |
| `request.user` | string \| null | The OpenAI `user` field. | `request.user == "batch-job"` |
| `user.id` | string \| null | Authenticated user id (verifier-dependent). | `user.id != null` |
| `user.authenticated` | bool | Whether any verifier accepted the request. | `user.authenticated` |
| `user.provider` | string \| null | The auth verifier type that authenticated the request. | `user.provider == "firebase-auth"` |
| `user.claims` | map | Claims from the accepted credential(s). | `has(user.claims.tier) && user.claims.tier == "pro"` |
| `device.id` | string \| null | Device identity (App Check app id, App Attest key id, ...). | `device.id != null` |
| `http.method` | string | Request method. | `http.method == "POST"` |
| `http.path` | string | Request path. | `http.path == "/v1/embeddings"` |
| `http.ip` | string \| null | Best-effort client IP (`cf-connecting-ip`, first `x-forwarded-for` entry, `x-real-ip`). | `http.ip == "203.0.113.7"` |
| `http.headers` | map | Lowercased header names. `authorization`, `cookie`, `set-cookie` and `x-api-key` values are redacted to `"<redacted>"`. | `"x-canary" in http.headers` |
| `now` | int | Epoch milliseconds. | `now % 86400000 < 43200000` |

**Gotcha — missing map keys throw.** In CEL, accessing a key that does not exist (e.g.
`user.claims.tier` for a token without a `tier` claim) **throws** at evaluation time; it does not
yield `null`. For routing/rate-limit conditions a throw is treated as "no match", so the typical
symptom is a rule that silently never fires. Guard optional keys:

```text
has(user.claims.tier) && user.claims.tier == "pro"
"tier" in user.claims && user.claims["tier"] == "pro"
```

And remember: only the boolean `true` counts as a match — write comparisons, not bare values.

## Environment variable interpolation

Every string value in the file supports environment references, resolved **before** validation, so
secrets never live in the config file:

| Syntax | Meaning |
| --- | --- |
| `${VAR}` | The value of `VAR`. A missing variable is a startup `ConfigError`. |
| `${VAR:-default}` | The value of `VAR`, or `default` when `VAR` is unset. |
| `$${VAR}` | Escape: the literal string `${VAR}`. |

```yaml
providers:
  openai:
    type: openai
    apiKey: ${OPENAI_API_KEY}
    baseUrl: ${OPENAI_BASE_URL:-https://api.openai.com/v1}
```
