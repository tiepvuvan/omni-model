import type { ZodTypeLike } from "../schema-shape.js";
import type { StorageAdapter } from "../storage/types.js";
import type { RuntimeContext } from "../types.js";

/** The verified identity attached to a request. */
export interface Identity {
  /** Verifier type that authenticated the request, e.g. "firebase-auth". */
  provider: string;
  /** Stable user identifier (JWT `sub`, Firebase uid, ...). */
  userId?: string;
  /** Stable device identifier (App Check app id, App Attest key id, ...). */
  deviceId?: string;
  /** Verified claims, exposed to CEL expressions as `user.claims`. */
  claims: Record<string, unknown>;
}

export type AuthResult =
  | { ok: true; identity: Identity }
  | { ok: false; reason: string; status?: number };

/** Runtime services available to verifiers, including shared storage. */
export interface VerifyContext extends RuntimeContext {
  storage: StorageAdapter;
  /**
   * Best-effort client IP from a trusted proxy header or the connection peer.
   * Undefined only for third-party embedders that predate this field.
   */
  clientIp?: string | null;
  /** Maximum provider-neutral input-token estimate for this runtime bundle. */
  maxInputTokens?: number;
}

/**
 * An extra HTTP route a verifier needs (e.g. App Attest challenge issuance
 * and attestation registration). Mounted by the server outside of `/v1`.
 */
export interface AuthRoute {
  method: "GET" | "POST";
  path: string;
  handler: (request: Request, ctx: VerifyContext) => Promise<Response>;
}

export interface AuthVerifier {
  /** Factory type, e.g. "firebase-app-check". */
  readonly type: string;
  /** Instance name (from config `name:`, defaults to the type). */
  readonly name: string;
  /**
   * Verify the request's credential.
   *
   * Returns `null` when the request carries no credential this verifier is
   * responsible for (e.g. its header is absent). For the user verifier that is a
   * rejection — a request must say who it is. For an app verifier under
   * `appAuth.mode: any` the next one is consulted. Returns `{ ok: false }` when a
   * credential was presented but is invalid; under `any` a later verifier may
   * still accept the request, but if none does, the first explicit failure's
   * reason (and status) is what the client receives.
   */
  verify(request: Request, ctx: VerifyContext): Promise<AuthResult | null>;
  routes?: AuthRoute[];
}

/**
 * Which authentication question a verifier answers.
 *
 * The two are not interchangeable and the configuration keeps them apart:
 * `user` verifiers answer "which person" and exactly one is required, `app`
 * verifiers answer "which app or device this is running on" and any number may
 * be layered over it. Declaring it here rather than listing types anywhere else
 * is what lets a new verifier — reCAPTCHA, Play Integrity — land in the right
 * half of the dashboard with no dashboard change: `GET /admin/api/meta`
 * publishes it.
 */
export type AuthLayer = "user" | "app";

export interface AuthVerifierFactory {
  readonly type: string;
  /** Which of the two authentication layers this verifier belongs to. */
  readonly layer: AuthLayer;
  /**
   * The zod schema this factory validates its options with.
   *
   * Optional, and purely descriptive: validation still happens inside `create`.
   * Exposing it lets the admin API publish the real option contracts as JSON
   * Schema, so a dashboard renders a form per component type instead of
   * hardcoding one for each — and cannot drift from what the factory accepts.
   */
  readonly optionsSchema?: ZodTypeLike;

  /**
   * `options` is one entry of `security.providers` from the environment configuration;
   * factories validate their own options with zod.
   */
  create(options: Record<string, unknown>, runtime: RuntimeContext): AuthVerifier;
}
