# Your extension is installed

This instance deployed two callable Cloud Functions in `${param:LOCATION}`:

| Function     | Callable name (client)             | Purpose                          |
| ------------ | ---------------------------------- | -------------------------------- |
| `chat`       | `ext-${param:EXT_INSTANCE_ID}-chat`       | OpenAI-compatible chat completions (streaming) |
| `embeddings` | `ext-${param:EXT_INSTANCE_ID}-embeddings` | OpenAI-compatible embeddings     |

The callable name is always `ext-<instance-id>-<function>`. If you installed with the
default instance id, the chat function is `ext-omni-model-proxy-chat`.

# Call it from your app

Your app must send a signed-in Firebase user (and an App Check token if enforcement is
on). The Firebase SDK attaches both automatically once Auth and App Check are initialized.

## Web (streaming)

```js
import { getFunctions, httpsCallable } from "firebase/functions";

const functions = getFunctions(app, "${param:LOCATION}");
const chat = httpsCallable(functions, "ext-omni-model-proxy-chat");

// Streaming: iterate chunks as they arrive.
const { stream, data } = await chat.stream({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Write a haiku about the sea." }],
});

for await (const chunk of stream) {
  // Each chunk is an OpenAI `chat.completion.chunk`.
  process.stdout.write(chunk.choices?.[0]?.delta?.content ?? "");
}

// `data` resolves to the aggregated `chat.completion`.
const final = await data;
console.log(final.usage);
```

## Web (non-streaming)

```js
const chat = httpsCallable(functions, "ext-omni-model-proxy-chat");
const res = await chat({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(res.data.choices[0].message.content);
```

## Embeddings

```js
const embed = httpsCallable(functions, "ext-omni-model-proxy-embeddings");
const res = await embed({ model: "text-embedding-3-small", input: "hello world" });
console.log(res.data.data[0].embedding.length);
```

# What the model receives

The request payload is an OpenAI Chat Completions / Embeddings request body. `model` is
routed to a provider by your configuration; unknown OpenAI fields pass through to the
upstream. Do **not** set `stream` in the body — the callable derives streaming from
`.stream()` vs a plain call.

# Rate limits

Each authenticated user is limited to **${param:REQUESTS_PER_HOUR} requests/hour**
and **${param:DAILY_TOKEN_BUDGET} tokens/day**. Exceeding a limit returns a
`resource-exhausted` callable error. Counters live in the Firestore collection
`${param:FIRESTORE_COLLECTION}`.

# Monitoring

Watch function logs and errors in the
[Cloud Functions dashboard](https://console.firebase.google.com/project/_/functions).
Rate-limiting is fail-open: if Firestore is briefly unavailable, requests are allowed
rather than blocked.
