import type { Context, MiddlewareHandler } from "hono";
import type { AuthVerifier, Identity, VerifyContext } from "../auth/types.js";
import { OmniError, unauthorized } from "../errors.js";
import type { RuntimeBundle } from "../runtime/bundle.js";
import type { AppEnv } from "./types.js";

function authError(reason: string, status = 401): OmniError {
  if (status === 401) {
    return unauthorized(reason);
  }
  return new OmniError(status, reason, {
    ...(status === 503 ? { code: "verification_unavailable" } : {}),
  });
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
 * Merge the identities the two layers produced.
 *
 * Merge rules (in verifier config order):
 * - `userId` / `deviceId`: the first defined value wins.
 * - `provider`: taken from the identity that supplied `userId`, falling back
 *   to the first identity.
 * - `providers`: every accepted verifier type, in verifier config order.
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
    providers: [
      ...new Set(entries.flatMap((entry) => entry.identity.providers ?? [entry.identity.provider])),
    ],
    userId: withUser?.identity.userId,
    deviceId: withDevice?.identity.deviceId,
    claims,
  };
}

export interface AuthMiddlewareOptions {
  /**
   * The bundle to authenticate against, read per request so a configuration
   * reload changes verifiers without rebuilding the app. Throws a 503 when the
   * proxy is unconfigured — which is also what keeps `/v1/*` closed until a
   * verifier exists.
   */
  requireBundle: () => RuntimeBundle;
  /** Build the per-request `VerifyContext` (runtime + storage). */
  contextFor: (c: Context<AppEnv>, bundle: RuntimeBundle) => VerifyContext;
}

/**
 * Authentication middleware for `/v1/*`, in two layers.
 *
 * **Layer 1 — the user.** One verifier, always configured, always required. A
 * `null` result (no credential presented) is a rejection here: a request that
 * does not say who it is has nothing to charge tokens to.
 *
 * **Layer 2 — the app or device.** Zero or more, layered over the user.
 * `appAuth.mode: all` requires every configured scheme to accept, with a `null`
 * counting as "credential missing for <name>". `any` takes the first that
 * accepts, moves past a `null`, remembers the first explicit failure, and rejects
 * when nothing accepted — which is what a deployment serving several platforms
 * wants, since a client can only satisfy its own platform's scheme.
 *
 * Identities from both layers are combined with `mergeIdentities`, so `user.id`
 * comes from layer 1 and `user.providers` records every verifier that accepted.
 *
 * Public paths (exact or trailing-`*` prefix) bypass verification entirely.
 *
 * There is no "nothing configured" branch: a bundle cannot exist without a user
 * verifier, so the only way to reach `/v1/*` unauthenticated is a public path you
 * asked for.
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler<AppEnv> {
  const { requireBundle, contextFor } = options;

  return async (c, next) => {
    const bundle = requireBundle();
    const { publicPaths, userVerifier, appVerifiers, appAuthMode } = bundle;
    if (isPublicPath(c.req.path, publicPaths)) {
      c.set("identity", null);
      return next();
    }
    const ctx = contextFor(c, bundle);

    // Layer 1: the user. `null` is a rejection, not a fall-through — there is
    // nowhere else for a user credential to come from.
    const user = await userVerifier.verify(c.req.raw, ctx);
    if (user === null) throw authError("authentication required");
    if (!user.ok) throw authError(user.reason, user.status);

    const accepted: { verifier: AuthVerifier; identity: Identity }[] = [
      { verifier: userVerifier, identity: user.identity },
    ];

    // Layer 2: the app or device, when any is configured.
    if (appVerifiers.length > 0) {
      if (appAuthMode === "any") {
        let firstFailure: { ok: false; reason: string; status?: number } | null = null;
        let attested: { verifier: AuthVerifier; identity: Identity } | null = null;
        for (const verifier of appVerifiers) {
          const result = await verifier.verify(c.req.raw, ctx);
          if (result === null) continue;
          if (result.ok) {
            attested = { verifier, identity: result.identity };
            break;
          }
          if (firstFailure === null) firstFailure = result;
        }
        if (attested === null) {
          throw authError(firstFailure?.reason ?? "app attestation required", firstFailure?.status);
        }
        accepted.push(attested);
      } else {
        for (const verifier of appVerifiers) {
          const result = await verifier.verify(c.req.raw, ctx);
          if (result === null) throw authError(`credential missing for ${verifier.name}`);
          if (!result.ok) throw authError(result.reason, result.status);
          accepted.push({ verifier, identity: result.identity });
        }
      }
    }

    c.set("identity", mergeIdentities(accepted));
    return next();
  };
}
