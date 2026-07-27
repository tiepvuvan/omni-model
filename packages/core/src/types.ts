/** Minimal logging interface. Implementations decide where log lines go. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Result of consuming a Firebase App Check token for replay protection. */
export interface FirebaseAppCheckTokenConsumption {
  /** Whether Firebase had already consumed this limited-use token. */
  alreadyConsumed: boolean;
}

/** Platform hook that consumes a Firebase App Check limited-use token. */
export type FirebaseAppCheckTokenConsumer = (
  token: string,
) => Promise<FirebaseAppCheckTokenConsumption>;

/** Options for obtaining an OAuth access token for a Google API. */
export interface GoogleAccessTokenRequest {
  /** OAuth scopes the target API requires. */
  scopes: readonly string[];
  /**
   * Optional service-account JSON supplied by verifier configuration.
   * When absent, the runtime uses Application Default Credentials.
   */
  serviceAccountKey?: string;
}

/** Platform hook that obtains a Google OAuth access token. */
export type GoogleAccessTokenProvider = (request: GoogleAccessTokenRequest) => Promise<string>;

/**
 * Runtime services injected into every pluggable component (auth verifiers,
 * model providers, storage factories). Nothing here touches a global, which is
 * what keeps core runtime-agnostic and every component testable offline: tests
 * inject a fake `fetch` and a fixed `now()`.
 */
export interface RuntimeContext {
  /** Environment variables / platform secrets. */
  env: Record<string, string | undefined>;
  /** Platform fetch. Components must call this instead of the global. */
  fetch: typeof fetch;
  /** Current epoch time in milliseconds. Injectable for tests. */
  now(): number;
  /**
   * Schedule work to continue after the response has been sent
   * (`ctx.waitUntil` on Workers, fire-and-forget on Node).
   */
  waitUntil(promise: Promise<unknown>): void;
  /**
   * Optional Firebase Admin SDK hook for App Check replay protection. The Node
   * runtime supplies it when an App Check verifier enables `consume`.
   */
  consumeFirebaseAppCheckToken?: FirebaseAppCheckTokenConsumer;
  /**
   * Optional Google OAuth hook. The Node runtime supplies it through
   * google-auth-library, keeping credential discovery and Workload Identity
   * Federation out of runtime-agnostic core.
   */
  getGoogleAccessToken?: GoogleAccessTokenProvider;
  log: Logger;
}
