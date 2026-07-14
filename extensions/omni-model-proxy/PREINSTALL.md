Use this extension to call OpenAI, Anthropic (Claude), and Google Gemini directly
from your mobile or web app — with **no backend to write or operate**.

The extension deploys two [callable Cloud Functions](https://firebase.google.com/docs/functions/callable):

- **`chat`** — an OpenAI-compatible chat completions endpoint (supports streaming).
- **`embeddings`** — an OpenAI-compatible embeddings endpoint.

Your app calls them with the Firebase SDK's `httpsCallable(...)`. Every request is
authenticated by the [callable protocol](https://firebase.google.com/docs/app-check/cloud-functions):

- **Firebase Auth** identifies the user (and keys the per-user rate limits).
- **Firebase App Check** proves the call came from your genuine app, blocking abuse.

Requests are routed to the provider you configure, and each user is held to a
**requests-per-minute** limit and a **daily token budget**, tracked in Firestore.

# What you configure

- One or more provider API keys (OpenAI / Anthropic / Gemini) — at least one is required.
- A default provider and per-user rate limits.
- Whether Firebase Auth and App Check are required (both strongly recommended).
- Optionally, a full advanced `omni.yaml` configuration for custom routing rules or
  additional OpenAI-compatible providers.

# Prerequisites

Before installing, make sure you have:

- A Firebase project on the **Blaze (pay-as-you-go) plan** — required for Cloud
  Functions and outbound network calls to the provider APIs.
- **[Firebase Authentication](https://firebase.google.com/docs/auth)** enabled and
  wired into your app, so callers arrive with a signed-in user.
- **[Firebase App Check](https://firebase.google.com/docs/app-check)** configured in
  your app (reCAPTCHA / DeviceCheck / App Attest / Play Integrity) if you keep App
  Check enforcement on (the default).
- **Cloud Firestore** enabled in your project (used for rate-limit counters).
- At least one provider **API key** (OpenAI, Anthropic, or Google Gemini).

# Billing

This extension uses services that may be billable:

- Cloud Functions (2nd gen) and Cloud Run
- Cloud Firestore
- Outbound network egress to the AI provider APIs

You are also billed directly by the AI providers (OpenAI / Anthropic / Google) for
the tokens your users consume.
