import { type Identity, OmniError } from "@omni-model/core";

/**
 * Structural view of a Firebase callable's Auth context. Present only when the
 * client sent a valid Firebase Auth ID token; `token` holds the decoded claims.
 * The firebase-functions `AuthData` satisfies this structurally, so the actual
 * `onCall` wiring in the extension needs no adapter.
 */
export interface CallableAuthLike {
  uid: string;
  token?: Record<string, unknown>;
}

/**
 * Structural view of a Firebase callable's App Check context. Present only when
 * the client sent a valid App Check token. `alreadyConsumed` is true when
 * replay protection has already spent this token.
 */
export interface CallableAppCheckLike {
  appId: string;
  alreadyConsumed?: boolean;
}

/**
 * Structural view of a Firebase `CallableRequest`. `auth` / `app` are absent
 * (undefined) when their token was not presented; `acceptsStreaming` is true
 * when the client invoked the function with `.stream()`.
 */
export interface CallableRequestLike<T = unknown> {
  data: T;
  auth?: CallableAuthLike;
  app?: CallableAppCheckLike;
  acceptsStreaming?: boolean;
}

/**
 * Structural view of the callable streaming response. `sendChunk` is a no-op
 * when the client did not request streaming; the handler's return value is the
 * final aggregated result the client awaits either way.
 */
export interface CallableResponseLike {
  sendChunk(chunk: unknown): void;
}

/** The canonical Firebase callable error codes this adapter emits. */
export type CallableErrorCode =
  | "invalid-argument"
  | "unauthenticated"
  | "permission-denied"
  | "failed-precondition"
  | "resource-exhausted"
  | "not-found"
  | "unavailable"
  | "internal";

/**
 * A Firebase-callable-shaped error. The extension's `onCall` wrapper maps this
 * to an `HttpsError` with the same `code`; keeping it framework-free here means
 * the adapter is testable without a firebase-functions dependency.
 */
export class CallableError extends Error {
  readonly code: CallableErrorCode;
  readonly details?: unknown;

  constructor(code: CallableErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CallableError";
    this.code = code;
    this.details = details;
  }
}

/** Map an HTTP-style status onto the closest canonical callable error code. */
export function callableErrorFromStatus(status: number, message: string): CallableError {
  return new CallableError(codeForStatus(status), message);
}

function codeForStatus(status: number): CallableErrorCode {
  switch (status) {
    case 400:
      return "invalid-argument";
    case 401:
      return "unauthenticated";
    case 403:
      return "permission-denied";
    case 404:
      return "not-found";
    case 429:
      return "resource-exhausted";
    case 503:
      return "unavailable";
    default:
      return "internal";
  }
}

/**
 * Normalize any thrown value into a {@link CallableError}. Already-callable
 * errors pass through; {@link OmniError} maps by its status. Anything else
 * becomes a generic `internal` error — its message and stack are deliberately
 * dropped so upstream/internal details never leak to the client.
 */
export function toCallableError(error: unknown): CallableError {
  if (error instanceof CallableError) return error;
  if (error instanceof OmniError) return callableErrorFromStatus(error.status, error.message);
  return new CallableError("internal", "internal error");
}

/**
 * Derive the omni-model {@link Identity} from a callable request, enforcing the
 * configured Auth / App Check requirements first.
 *
 * Throws a {@link CallableError} when a requirement is unmet: a missing App
 * Check token is `failed-precondition`, an already-consumed one (replay) is
 * `unauthenticated`, and a missing Auth token when auth is required is
 * `unauthenticated`. On success the identity carries the Firebase uid, the App
 * Check app id as the device id, and the decoded ID-token claims.
 */
export function identityFromCallable(
  request: CallableRequestLike,
  options: { requireAuth: boolean; requireAppCheck: boolean },
): Identity {
  if (options.requireAppCheck && request.app === undefined) {
    throw new CallableError("failed-precondition", "App Check token required");
  }
  if (request.app?.alreadyConsumed === true) {
    throw new CallableError("unauthenticated", "App Check token already used");
  }
  if (options.requireAuth && request.auth === undefined) {
    throw new CallableError("unauthenticated", "Authentication required");
  }
  return {
    provider: "firebase",
    userId: request.auth?.uid,
    deviceId: request.app?.appId,
    claims: request.auth?.token ?? {},
  };
}
