/**
 * What each configurable field is for, in an operator's terms.
 *
 * The factories' zod schemas carry `description` on some fields and nothing on
 * others, and where they do it is written for a contributor reading the source
 * ("Header carrying the raw App Check token") rather than for someone deciding
 * what to type. This is the operator-facing copy: what the value is, where to
 * find it, and what happens if it is wrong.
 *
 * Keyed `"<component type>.<field>"`, falling back to `"*.<field>"` for fields
 * that mean the same thing everywhere. A field with no entry falls back to the
 * schema's own description, and `test/help.test.ts` asserts that every field the
 * screens actually render has copy here — so adding a verifier to a card without
 * writing its help is a failing test rather than a blank hint.
 */
const HELP: Record<string, string> = {
  /* Shared across components. */
  "*.apiKey":
    "The provider API key. Typed in plaintext and sealed into encrypted storage before the revision is written — it is never readable again, from here or from the API.",
  "*.baseUrl": "The API root, including any version segment. No trailing slash.",
  "*.model":
    "The upstream model name to forward as. Leave blank to pass the client's own model through unchanged.",
  "*.name":
    "A label for your own reference, recorded on each request as the provider that authenticated it. Defaults to the type.",

  /* Custom JWT. */
  "jwt.secret":
    "The shared secret your issuer signs with, for HS256-family algorithms. Sealed into encrypted storage before the revision is written — it is never readable again. Use this or a public key or a JWKS URL, not more than one.",
  "jwt.publicKey":
    "The PEM public key your issuer signs with, for RS/ES-family algorithms. Use this or a shared secret or a JWKS URL.",
  "jwt.jwksUrl":
    "Where to fetch signing keys from, if your issuer publishes a JWKS. Keys are cached and refetched on an unknown key id.",
  "jwt.algorithms":
    "Which signing algorithms to accept, for example HS256 or RS256. Leave empty to accept any the key supports — pinning them is safer.",
  "jwt.issuer": "Reject any token whose `iss` claim is not this. Leave empty to skip the check.",
  "jwt.audience":
    "Reject any token whose `aud` claim does not include this. Leave empty to skip the check.",
  "jwt.header": "Which request header carries the token. Defaults to Authorization.",
  "jwt.scheme":
    "The scheme in front of the token — `bearer` for `Authorization: Bearer <token>`, or `raw` for a bare token.",
  "jwt.userIdClaim": "Which claim identifies the user. Defaults to `sub`.",
  "jwt.deviceIdClaim": "Which claim identifies the device, if your tokens carry one.",
  "jwt.clockToleranceSeconds":
    "How much clock skew to forgive on `exp` and `nbf`, in seconds. Keep it small.",

  /* Firebase. */
  "firebase-auth.projectId":
    "Your Firebase project id — the one in the console URL, not the numeric project number.",
  "firebase-auth.header": "Which request header carries the Firebase ID token.",
  "firebase-auth.clockToleranceSeconds": "How much clock skew to forgive, in seconds.",
  "firebase-app-check.projectNumber":
    "The *numeric* project number from your Firebase settings, not the project id.",
  "firebase-app-check.appIds":
    "Only accept App Check tokens issued to these app ids. Leave empty to accept any app in the project.",
  "firebase-app-check.consume":
    "Consume limited-use tokens through Firebase so a token cannot be replayed. Needs Firebase Admin credentials in the container and adds a round trip per request.",
  "firebase-app-check.header": "Which request header carries the App Check token.",

  /* Web and Android application verification. */
  "cloudflare-turnstile.secret":
    "The widget secret from Cloudflare. It is sealed into encrypted storage and used only for server-side Siteverify calls.",
  "cloudflare-turnstile.action":
    "If set, require the action returned by Turnstile to match exactly.",
  "cloudflare-turnstile.hostnames":
    "Only accept tokens created on these hostnames. Leave empty to rely on the widget's Cloudflare hostname policy.",
  "cloudflare-turnstile.header": "Which request header carries the fresh Turnstile token.",
  "recaptcha-enterprise.projectId": "The Google Cloud project that owns the reCAPTCHA key.",
  "recaptcha-enterprise.siteKey": "The reCAPTCHA Enterprise key used by the client.",
  "recaptcha-enterprise.apiKey":
    "A server-restricted Google API key for creating assessments. Sealed on save. Leave empty to use ADC or Workload Identity Federation.",
  "recaptcha-enterprise.expectedAction":
    "The action passed to grecaptcha.enterprise.execute(). Tokens for any other action are rejected.",
  "recaptcha-enterprise.minScore":
    "The lowest score to accept, from 0 to 1. Choose this from observed traffic rather than treating 0.5 as universal.",
  "recaptcha-enterprise.hostnames":
    "Only accept web tokens generated on these hostnames. Leave empty to rely on the reCAPTCHA key policy.",
  "recaptcha-enterprise.serviceAccountKey":
    "Optional service-account JSON for assessment creation. Sealed on save. Leave empty to use an API key, ADC, or Workload Identity Federation.",
  "recaptcha-enterprise.header":
    "Which request header carries the fresh reCAPTCHA Enterprise token.",
  "recaptcha-enterprise.androidPackageNames":
    "Only accept Android tokens generated by these package names.",
  "recaptcha-enterprise.iosBundleIds":
    "Only accept iOS tokens generated by these bundle identifiers.",
  "google-play-integrity.packageName":
    "The Android application id linked to Play Integrity, for example com.example.app.",
  "google-play-integrity.serviceAccountKey":
    "Optional service-account JSON with Play Integrity access. Sealed on save. Leave empty to use ADC or Workload Identity Federation.",
  "google-play-integrity.deviceRecognitionVerdicts":
    "Accept when Google returns any one of these device-integrity labels.",
  "google-play-integrity.requireLicensed":
    "Require the signed-in Play account to hold a license for this app.",
  "google-play-integrity.certificateSha256Digests":
    "Optional base64url SHA-256 allowlist for Play app-signing certificates.",
  "google-play-integrity.header":
    "Which request header carries the fresh encrypted Play Integrity token.",
  "google-play-integrity.maxAge":
    "How fresh the Play Integrity request timestamp must be, for example 2m.",
  "google-play-integrity.clockToleranceSeconds":
    "How much future clock skew to tolerate on the device timestamp, in seconds.",

  /* Supabase. */
  "supabase.baseUrl":
    "Your Supabase project URL, for example https://project-id.supabase.co. Used to derive the JWKS URL when you do not set one.",
  "supabase.jwksUrl":
    "Override where signing keys are fetched from. Defaults to your project's well-known JWKS endpoint.",
  "supabase.jwtSecret":
    "The legacy JWT secret from your project's API settings, for projects still signing with HS256. Sealed into encrypted storage on save.",
  "supabase.audience": "Reject tokens whose `aud` is not this. Supabase issues `authenticated`.",

  /* Apple. */
  "apple-app-attest.teamId": "Your Apple Developer team id, ten characters.",
  "apple-app-attest.bundleId": "The app's bundle identifier, for example com.example.app.",
  "apple-app-attest.environment":
    "`production` for App Store and TestFlight builds; `development` for builds run from Xcode. A mismatch rejects every attestation.",
  "apple-app-attest.challengeTtl":
    "How long a challenge stays valid, for example 5m. Shorter is safer; too short and a slow device fails.",
  "apple-app-attest.rootCaPem":
    "Override Apple's App Attest root certificate. Leave empty unless Apple has rotated it and this build predates the change.",
  "apple-device-check.teamId": "Your Apple Developer team id, ten characters.",
  "apple-device-check.keyId":
    "The key id of the DeviceCheck private key, from the developer portal.",
  "apple-device-check.privateKey":
    "The DeviceCheck `.p8` private key contents, including the BEGIN and END lines. Sealed into encrypted storage before the revision is written — it is never readable again.",

  /* Providers. */
  "openai.organization":
    "Bill usage to a specific OpenAI organization. Leave empty for the default.",
  "openai-compatible.baseUrl":
    "The OpenAI-compatible API root, for example https://api.groq.com/openai/v1. Required — there is no sensible default.",
  "openai-compatible.apiKey":
    "The API key, if the endpoint needs one. Local model servers often do not.",
  "*.headers": "Extra headers to send upstream, as a JSON object. Merged over the computed ones.",
  "*.models":
    "A static model list to answer with when the upstream has no discovery endpoint or it fails.",
  "*.includeStreamUsage":
    "Ask the upstream to report token usage in the final stream chunk. Leave on — token budgets depend on it.",
  "anthropic.version": "The Anthropic API version header. Leave empty for the supported default.",
  "anthropic.maxTokensDefault":
    "Anthropic requires max_tokens; this is what to send when the client omits it.",
  "google.apiKey": "A Google AI Studio API key. Sealed into encrypted storage on save.",
};

/**
 * Help text for one field of one component type.
 *
 * `schemaDescription` is the fallback rather than the preference: it exists for
 * contributors and is often about the implementation, so operator-facing copy
 * wins where there is any.
 */
export function helpFor(
  componentType: string,
  field: string,
  schemaDescription?: string,
): string | undefined {
  return HELP[`${componentType}.${field}`] ?? HELP[`*.${field}`] ?? schemaDescription;
}

/** Every key, so a test can check the screens' fields are all covered. */
export function helpKeys(): string[] {
  return Object.keys(HELP);
}
