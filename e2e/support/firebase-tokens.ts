/**
 * Mint REAL Firebase credentials over Google's public REST APIs, so the auth
 * e2e verifies omni-model's `firebase-auth` / `firebase-app-check` verifiers
 * against genuine tokens from a genuine project — exactly what an iOS app's
 * FirebaseAuth / FirebaseAppCheck SDKs would send.
 *
 * The API key is the app's client Firebase key (the one embedded in every iOS
 * build; safe to use here). Nothing is persisted.
 */

/**
 * Sign up an anonymous user via the Identity Toolkit and return its ID token
 * (RS256 JWT: iss=https://securetoken.google.com/<projectId>, aud=<projectId>).
 * Requires the project's Anonymous sign-in provider to be enabled.
 */
export async function mintFirebaseIdToken(apiKey: string): Promise<string> {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }),
    },
  );
  const json = (await res.json()) as { idToken?: string; error?: { message?: string } };
  if (!res.ok || !json.idToken) {
    throw new Error(
      `Firebase accounts:signUp failed (${res.status}): ${json.error?.message ?? "no idToken"} ` +
        "— is Anonymous sign-in enabled for this project?",
    );
  }
  return json.idToken;
}

/**
 * Exchange a registered App Check **debug token** (Firebase console →
 * App Check → Apps → Manage debug tokens) for a real App Check token
 * (RS256 JWT: iss=.../<projectNumber>, aud contains projects/<projectNumber>,
 * sub=<appId>). This is the only way to obtain a genuine App Check token
 * without a physical device.
 */
export async function exchangeAppCheckDebugToken(args: {
  apiKey: string;
  projectNumber: string;
  appId: string;
  debugToken: string;
}): Promise<string> {
  const res = await fetch(
    `https://firebaseappcheck.googleapis.com/v1/projects/${args.projectNumber}/apps/${args.appId}:exchangeDebugToken?key=${args.apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ debugToken: args.debugToken, limitedUse: false }),
    },
  );
  const json = (await res.json()) as { token?: string; error?: { message?: string } };
  if (!res.ok || !json.token) {
    throw new Error(
      `App Check exchangeDebugToken failed (${res.status}): ${json.error?.message ?? "no token"} ` +
        "— is the debug token registered for this app id?",
    );
  }
  return json.token;
}
