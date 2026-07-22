import type { Context } from "hono";
import type { Identity } from "../auth/types.js";
import type { OmniConfig } from "../config/schema.js";
import type { OmniRegistry } from "../registry.js";
import type { ExpressionEngine, RequestFacts } from "../routing/types.js";
import type { StorageAdapter } from "../storage/types.js";
import type { FirebaseAppCheckTokenConsumer, Logger } from "../types.js";

/**
 * Options for `createOmniApp`. Only `config` is required; every other field
 * has a sensible default so `createOmniApp({ config })` works on any
 * fetch-based runtime. Tests inject `fetch`, `now` and `waitUntil` to stay
 * deterministic and offline.
 */
export interface OmniAppInit {
  /** Validated configuration, typically from `parseConfig`. */
  config: OmniConfig;
  /** Component factories; defaults to `createDefaultRegistry()`. */
  registry?: OmniRegistry;
  /** Environment variables exposed to components; defaults to `{}`. */
  env?: Record<string, string | undefined>;
  /** Pre-built storage adapter. When provided, overrides `config.storage`. */
  storage?: StorageAdapter;
  /** Expression engine for routing/rate-limit conditions; defaults to CEL. */
  engine?: ExpressionEngine;
  /** Outbound fetch; defaults to a bound `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Clock; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Fallback for post-response work when the platform provides no execution
   * context (`c.executionCtx` throws outside Workers).
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Firebase Admin replay-protection hook for App Check limited-use tokens.
   * The Node runtime supplies this when the App Check verifier enables
   * `consume`; other runtimes may omit it.
   */
  consumeFirebaseAppCheckToken?: FirebaseAppCheckTokenConsumer;
  /** Defaults to `createConsoleLogger(config.server.logLevel)`. */
  logger?: Logger;
  /**
   * Resolve the client IP used for rate-limit keys. Defaults to a header-only
   * resolver that honors forwarding headers exactly when
   * `config.server.trustProxyHeaders` is true. Platforms with access to the
   * connection socket (e.g. Node via `getConnInfo`) pass a resolver that
   * returns the real peer address when proxy headers are not trusted.
   */
  clientIp?: (c: Context<AppEnv>) => string | null;
}

/**
 * Hono environment for the omni app: per-request variables populated by the
 * auth middleware (`identity`) and the /v1 route handlers (`facts`).
 */
export interface AppEnv {
  Variables: {
    identity: Identity | null;
    facts: RequestFacts | undefined;
  };
}
