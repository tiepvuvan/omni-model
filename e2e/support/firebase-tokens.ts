import { createPrivateKey, randomUUID, sign } from "node:crypto";

/**
 * Mint REAL Firebase credentials over Google's public REST APIs, so the auth
 * e2e verifies omni-model's `firebase-auth` / `firebase-app-check` verifiers
 * against genuine tokens from a genuine project — exactly what an iOS app's
 * FirebaseAuth / FirebaseAppCheck SDKs would send.
 *
 * The API key is the app's client Firebase key (the one embedded in client
 * builds). Test users are deleted after use and credentials are never logged.
 */

/** A temporary Firebase user and its genuine client ID token. */
export interface FirebaseTestSession {
  /** Firebase Authentication ID token sent to omni-model. */
  idToken: string;
  /** Delete the temporary user created for this test. */
  delete(): Promise<void>;
}

/**
 * Create a disposable user and return its genuine Firebase client ID token.
 *
 * With service-account JSON, this exchanges a locally signed custom token and
 * works without changing the project's sign-in providers. Without it, the
 * helper falls back to anonymous sign-up, which must be enabled in Firebase.
 */
export async function createFirebaseTestSession(
  apiKey: string,
  options: { serviceAccountKey?: string } = {},
): Promise<FirebaseTestSession> {
  const customToken =
    options.serviceAccountKey === undefined
      ? undefined
      : createFirebaseCustomToken(options.serviceAccountKey);
  const operation =
    customToken === undefined ? "accounts:signUp" : "accounts:signInWithCustomToken";
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/${operation}?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(customToken === undefined ? {} : { token: customToken }),
      returnSecureToken: true,
    }),
  });
  const json = (await res.json()) as { idToken?: string; error?: { message?: string } };
  if (!res.ok || !json.idToken) {
    const code = firebaseErrorCode(json);
    throw new Error(
      `Firebase ${operation} failed (${res.status}${code === undefined ? "" : ` ${code}`}). ` +
        (customToken === undefined
          ? "Confirm the API key belongs to this project and Anonymous sign-in is enabled."
          : "Confirm the API key and service account belong to the same Firebase project."),
    );
  }
  const idToken = json.idToken;
  return {
    idToken,
    async delete(): Promise<void> {
      const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${apiKey}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idToken }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Firebase accounts:delete failed (${response.status})`);
      }
      await response.body?.cancel();
    },
  };
}

function createFirebaseCustomToken(serviceAccountKey: string): string {
  let value: unknown;
  try {
    value = JSON.parse(serviceAccountKey);
  } catch {
    throw new Error("Firebase Auth service-account input is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Firebase Auth service-account input is not a JSON object");
  }
  const account = value as Record<string, unknown>;
  if (
    account.type !== "service_account" ||
    typeof account.client_email !== "string" ||
    account.client_email === "" ||
    typeof account.private_key !== "string" ||
    account.private_key === ""
  ) {
    throw new Error(
      "Firebase Auth service-account input must contain type, client_email, and private_key",
    );
  }

  const encode = (input: unknown): string =>
    Buffer.from(JSON.stringify(input)).toString("base64url");
  const now = Math.floor(Date.now() / 1_000);
  const unsigned = [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({
      iss: account.client_email,
      sub: account.client_email,
      aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
      iat: now,
      exp: now + 3_600,
      uid: `omni-e2e-${randomUUID()}`,
    }),
  ].join(".");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(unsigned),
    createPrivateKey(account.private_key),
  ).toString("base64url");
  return `${unsigned}.${signature}`;
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
  limitedUse?: boolean;
}): Promise<string> {
  const res = await fetch(
    `https://firebaseappcheck.googleapis.com/v1/projects/${args.projectNumber}/apps/${args.appId}:exchangeDebugToken?key=${args.apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        debugToken: args.debugToken,
        limitedUse: args.limitedUse ?? false,
      }),
    },
  );
  const json = (await res.json()) as { token?: string; error?: { message?: string } };
  if (!res.ok || !json.token) {
    const code = firebaseErrorCode(json);
    throw new Error(
      `App Check exchangeDebugToken failed (` +
        `${res.status}${code === undefined ? "" : ` ${code}`}). ` +
        "Confirm the API key, project number, app id, and registered debug token.",
    );
  }
  return json.token;
}

function firebaseErrorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const error = (value as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  const message = (error as Record<string, unknown>).message;
  if (typeof message !== "string") return undefined;
  return /^([A-Z][A-Z0-9_]{2,})/.exec(message)?.[1];
}
