## Version 0.1.0

Initial release of the **omni-model AI proxy** Firebase Extension.

- Deploys two OpenAI-compatible callable Cloud Functions (2nd gen): `chat`
  (streaming chat completions) and `embeddings`.
- Client authentication via the Firebase callable protocol: Firebase Auth +
  App Check (both enforced by default; configurable).
- Routes requests to OpenAI, Anthropic (Claude), or Google Gemini based on the
  configured default provider.
- Per-user request-per-minute and daily-token-budget rate limits, backed by
  Cloud Firestore (fail-open).
- `ADVANCED_CONFIG_YAML` parameter for a full `omni.yaml` override (custom
  routing rules, additional OpenAI-compatible providers).
