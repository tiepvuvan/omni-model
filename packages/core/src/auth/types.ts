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
   * responsible for (e.g. its header is absent) — in `mode: any` the next
   * verifier is consulted. Returns `{ ok: false }` when a credential was
   * presented but is invalid; in `mode: any` later verifiers may still
   * authenticate the request, but if none does, the first explicit failure's
   * reason (and status) is what the client receives.
   */
  verify(request: Request, ctx: VerifyContext): Promise<AuthResult | null>;
  routes?: AuthRoute[];
}

export interface AuthVerifierFactory {
  readonly type: string;
  /**
   * `options` is one entry of `security.providers` from the environment configuration;
   * factories validate their own options with zod.
   */
  create(options: Record<string, unknown>, runtime: RuntimeContext): AuthVerifier;
}
