import type { Context } from "hono";
import type { Identity } from "../auth/types.js";
import type { PromptCache } from "../cache/types.js";
import type { OmniConfig } from "../config/schema.js";
import type { RequestLogSink } from "../logs/types.js";
import type { OmniRegistry } from "../registry.js";
import type { ExpressionEngine, RequestFacts } from "../routing/types.js";
import type { SecretStore } from "../secrets/types.js";
import type { StorageAdapter } from "../storage/types.js";
import type { FirebaseAppCheckTokenConsumer, GoogleAccessTokenProvider, Logger } from "../types.js";
import type { WriteKey, WriteKeyStore } from "../writekeys/types.js";
import type { RequestLogDraft } from "./logging.js";

/**
 * Everything except the configuration itself. Shared by `createOmniProxy`
 * (configuration arrives at runtime) and `createOmniApp` (configuration is
 * supplied up front). Tests inject `fetch`, `now` and `waitUntil` to stay
 * deterministic and offline.
 */
export interface OmniRuntimeInit {
  /** Component factories; defaults to `createDefaultRegistry()`. */
  registry?: OmniRegistry;
  /** Environment variables exposed to components; defaults to `{}`. */
  env?: Record<string, string | undefined>;
  /** Pre-built storage adapter. When provided, overrides `config.storage`. */
  storage?: StorageAdapter;
  /**
   * Decrypts `{"$secret": …}` references while building a bundle. Without it a
   * configuration containing one is rejected with an actionable message.
   */
  secrets?: SecretStore;
  /**
   * Resolves an OpenAI-compatible `Authorization: Bearer <publishable-key>` to a
   * calling application. Without it keys cannot be checked, so
   * `security.requireWriteKey` has nothing to enforce.
   */
  writeKeys?: WriteKeyStore;
  /** Where request logs go. Defaults to discarding them. */
  requestLogs?: RequestLogSink;
  /**
   * Where cached responses go. Without it `cache.enabled` has nothing to enable
   * — the deployment simply does not cache, and says so at build time.
   */
  promptCache?: PromptCache;
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
  /**
   * Google OAuth token hook for verifiers such as Play Integrity and
   * reCAPTCHA Enterprise. The Node runtime supplies ADC/WIF support.
   */
  getGoogleAccessToken?: GoogleAccessTokenProvider;
  /**
   * Pins the logger for every bundle. Omit it and each bundle gets a console
   * logger at its own `server.logLevel`, so the level is reconfigurable.
   */
  logger?: Logger;
  /**
   * Resolve the client IP used for rate-limit keys. Defaults to a header-only
   * resolver that honors forwarding headers exactly when `trustProxyHeaders`
   * is set. Platforms with access to the connection socket (e.g. Node via
   * `getConnInfo`) pass a resolver that returns the real peer address when
   * proxy headers are not trusted.
   *
   * `trustProxyHeaders` is passed in rather than captured because it is part of
   * the reloadable configuration.
   */
  clientIp?: (c: Context<AppEnv>, trustProxyHeaders: boolean) => string | null;
}

/**
 * Options for `createOmniProxy`. Configuration is optional: without it the
 * proxy boots unconfigured, serving `/healthz` and answering `/v1/*` with 503
 * until a configuration arrives.
 */
export interface OmniProxyInit extends OmniRuntimeInit {
  /** Initial configuration document, validated when the first bundle is built. */
  config?: unknown;
}

/** Options for `createOmniApp`: a validated configuration, applied at startup. */
export interface OmniAppInit extends OmniRuntimeInit {
  /** Validated configuration, typically from `parseConfig`. */
  config: OmniConfig;
}

/**
 * Hono environment for the omni app: per-request variables populated by the
 * auth middleware (`identity`) and the /v1 route handlers (`facts`).
 */
export interface AppEnv {
  Variables: {
    identity: Identity | null;
    /** Calling application, set by the write key middleware. */
    writeKey: WriteKey | null;
    facts: RequestFacts | undefined;
    /** Accumulating request log row; absent when request logging is off. */
    logDraft: RequestLogDraft | undefined;
  };
}
