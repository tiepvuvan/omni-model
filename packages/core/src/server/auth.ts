import type { Context, MiddlewareHandler } from "hono";
import type { AuthVerifier, Identity, VerifyContext } from "../auth/types.js";
import { type OmniError, unauthorized } from "../errors.js";
import type { AppEnv } from "./types.js";

function authError(reason: string): OmniError {
  return unauthorized(reason, { headers: { "WWW-Authenticate": "Bearer" } });
}

/** Exact match, or prefix match for patterns with a trailing `*`. */
export function isPublicPath(path: string, publicPaths: readonly string[]): boolean {
  for (const pattern of publicPaths) {
    if (pattern.endsWith("*")) {
      if (path.startsWith(pattern.slice(0, -1))) return true;
    } else if (path === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Merge the identities accepted by every verifier in `mode: all`.
 *
 * Merge rules (in verifier config order):
 * - `userId` / `deviceId`: the first defined value wins.
 * - `provider`: taken from the identity that supplied `userId`, falling back
 *   to the first identity.
 * - `claims`: the first identity's claims are flattened at the top level,
 *   then every verifier's claims are added namespaced under its `name`
 *   (`claims[verifierName] = thatVerifiersClaims`). A namespaced key
 *   overwrites a same-named top-level claim — pick verifier names that do not
 *   collide with claim names.
 */
export function mergeIdentities(
  entries: readonly { verifier: AuthVerifier; identity: Identity }[],
): Identity {
  const first = entries[0];
  if (first === undefined) {
    throw new Error("mergeIdentities requires at least one accepted identity");
  }
  const withUser = entries.find((entry) => entry.identity.userId !== undefined);
  const withDevice = entries.find((entry) => entry.identity.deviceId !== undefined);

  const claims: Record<string, unknown> = { ...first.identity.claims };
  for (const entry of entries) {
    claims[entry.verifier.name] = entry.identity.claims;
  }

  return {
    provider: (withUser ?? first).identity.provider,
    userId: withUser?.identity.userId,
    deviceId: withDevice?.identity.deviceId,
    claims,
  };
}

export interface AuthMiddlewareOptions {
  mode: "any" | "all";
  publicPaths: readonly string[];
  verifiers: readonly AuthVerifier[];
  /** Build the per-request `VerifyContext` (runtime + storage). */
  contextFor: (c: Context<AppEnv>) => VerifyContext;
}

/**
 * Authentication middleware for `/v1/*`.
 *
 * `mode: any` consults verifiers in order: the first `{ ok: true }` wins;
 * `null` (credential absent) moves on to the next verifier; `{ ok: false }`
 * is remembered and the request is rejected with the first failure's reason
 * unless a later verifier positively authenticates it. When every verifier
 * returns `null` the request is rejected with "authentication required".
 *
 * `mode: all` requires every verifier to accept; a `null` result counts as
 * "credential missing for <name>". Accepted identities are combined with
 * `mergeIdentities`.
 *
 * Public paths (exact or trailing-`*` prefix) bypass verification entirely.
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler<AppEnv> {
  const { mode, publicPaths, verifiers, contextFor } = options;

  return async (c, next) => {
    if (verifiers.length === 0 || isPublicPath(c.req.path, publicPaths)) {
      c.set("identity", null);
      return next();
    }
    const ctx = contextFor(c);

    if (mode === "any") {
      let firstFailure: { ok: false; reason: string } | null = null;
      for (const verifier of verifiers) {
        const result = await verifier.verify(c.req.raw, ctx);
        if (result === null) continue;
        if (result.ok) {
          c.set("identity", result.identity);
          return next();
        }
        if (firstFailure === null) firstFailure = result;
      }
      throw authError(firstFailure?.reason ?? "authentication required");
    }

    const accepted: { verifier: AuthVerifier; identity: Identity }[] = [];
    for (const verifier of verifiers) {
      const result = await verifier.verify(c.req.raw, ctx);
      if (result === null) throw authError(`credential missing for ${verifier.name}`);
      if (!result.ok) throw authError(result.reason);
      accepted.push({ verifier, identity: result.identity });
    }
    c.set("identity", mergeIdentities(accepted));
    return next();
  };
}
