import type { MiddlewareHandler } from "hono";
import { unauthorized } from "../errors.js";
import { looksLikeWriteKey } from "../writekeys/keys.js";
import { type WriteKeyState, type WriteKeyStore, writeKeyState } from "../writekeys/types.js";
import { isPublicPath } from "./auth.js";
import type { AppEnv } from "./types.js";

/**
 * OpenAI-compatible header carrying the publishable key.
 *
 * OpenAI SDKs already send their `apiKey` as `Authorization: Bearer …`, so using
 * that wire format lets them point at omni-model without transport adapters.
 * End-user verifiers use dedicated `X-*` headers and remain a separate layer.
 */
export const WRITE_KEY_HEADER = "authorization";

/** Authentication scheme used by OpenAI-compatible clients. */
export const WRITE_KEY_SCHEME = "Bearer";

function presentedSecret(value: string): string | null {
  const match = value.match(/^Bearer\s+(.+)$/i);
  const secret = match?.[1]?.trim();
  return secret === undefined || secret === "" ? null : secret;
}

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
          `missing publishable key: send Authorization: ${WRITE_KEY_SCHEME} <key>`,
          {
            code: "write_key_required",
            headers: { "WWW-Authenticate": WRITE_KEY_SCHEME },
          },
        );
      }
      return next();
    }

    const secret = presentedSecret(presented);
    if (secret === null) {
      throw unauthorized("invalid publishable key authorization", {
        code: "write_key_invalid",
        headers: { "WWW-Authenticate": WRITE_KEY_SCHEME },
      });
    }

    if (store === null) {
      // No store configured: a key cannot be checked, so it cannot be trusted.
      if (required()) {
        throw unauthorized("client keys are required but no write key store is configured", {
          code: "write_key_unavailable",
          headers: { "WWW-Authenticate": WRITE_KEY_SCHEME },
        });
      }
      return next();
    }

    // Cheap shape check first, so junk credentials never reach a store lookup.
    const writeKey = looksLikeWriteKey(secret) ? await store.authenticate(secret) : null;
    if (writeKey === null) {
      throw unauthorized("invalid client key", {
        code: "write_key_invalid",
        headers: { "WWW-Authenticate": WRITE_KEY_SCHEME },
      });
    }

    const state = writeKeyState(writeKey, now());
    if (state !== "active") {
      throw unauthorized(REASONS[state], {
        code: `write_key_${state}`,
        headers: { "WWW-Authenticate": WRITE_KEY_SCHEME },
      });
    }

    c.set("writeKey", writeKey);
    return next();
  };
}
