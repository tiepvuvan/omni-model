import type { MiddlewareHandler } from "hono";
import { unauthorized } from "../errors.js";
import { looksLikeWriteKey } from "../writekeys/keys.js";
import { type WriteKeyState, type WriteKeyStore, writeKeyState } from "../writekeys/types.js";
import { isPublicPath } from "./auth.js";
import type { AppEnv } from "./types.js";

/**
 * Header carrying the write key.
 *
 * Deliberately **not** `Authorization`: the jwt, firebase-auth and supabase
 * verifiers already own that header for the end user's token, and a client needs
 * to send both at once. Conflating them would make "which app" and "which user"
 * mutually exclusive.
 */
export const WRITE_KEY_HEADER = "x-omni-key";

/** Public reasons, deliberately specific enough to debug and no more. */
const REASONS: Record<Exclude<WriteKeyState, "active">, string> = {
  revoked: "this client key has been revoked",
  expired: "this client key has expired",
};

export interface WriteKeyMiddlewareOptions {
  /** Null disables lookups entirely; a presented key is then simply ignored. */
  store: WriteKeyStore | null;
  /** Reject requests that present no key at all. */
  required: () => boolean;
  publicPaths: () => readonly string[];
  now: () => number;
}

/**
 * Identify the calling application from its write key.
 *
 * Runs ahead of the auth verifiers, because "which app" is a cheaper and
 * coarser question than "which user": a revoked client should be turned away
 * before the proxy does any token verification work on its behalf.
 *
 * A presented key is **always** validated, even when keys are not required.
 * Otherwise a revoked client could keep working simply by dropping the header,
 * and every request log would be attributed to nobody.
 */
export function createWriteKeyMiddleware(
  options: WriteKeyMiddlewareOptions,
): MiddlewareHandler<AppEnv> {
  const { store, required, publicPaths, now } = options;

  return async (c, next) => {
    c.set("writeKey", null);
    if (isPublicPath(c.req.path, publicPaths())) return next();

    const presented = c.req.header(WRITE_KEY_HEADER);
    if (presented === undefined || presented.trim() === "") {
      if (required()) {
        throw unauthorized(
          `missing client key: send your write key in the ${WRITE_KEY_HEADER} header`,
          { code: "write_key_required" },
        );
      }
      return next();
    }

    if (store === null) {
      // No store configured: a key cannot be checked, so it cannot be trusted.
      if (required()) {
        throw unauthorized("client keys are required but no write key store is configured", {
          code: "write_key_unavailable",
        });
      }
      return next();
    }

    // Cheap shape check first, so junk credentials never reach a store lookup.
    const writeKey = looksLikeWriteKey(presented.trim())
      ? await store.authenticate(presented.trim())
      : null;
    if (writeKey === null) {
      throw unauthorized("invalid client key", { code: "write_key_invalid" });
    }

    const state = writeKeyState(writeKey, now());
    if (state !== "active") {
      throw unauthorized(REASONS[state], { code: `write_key_${state}` });
    }

    c.set("writeKey", writeKey);
    return next();
  };
}
