import type { OmniRegistry } from "../registry.js";
import type { ExpressionEngine } from "../routing/types.js";
import type { StorageAdapter } from "../storage/types.js";
import type { Logger, RuntimeContext } from "../types.js";
import { type BuildBundleInput, buildBundle, type RuntimeBundle } from "./bundle.js";

/** Outcome of a reload attempt. Never a thrown error: see {@link BundleHolder.reload}. */
export type ReloadResult =
  | { ok: true; bundle: RuntimeBundle }
  | { ok: false; error: string; kind: "invalid_config" };

/** What the proxy can say about itself to `/readyz` and to operators. */
export interface BundleStatus {
  /** Whether `/v1/*` can serve traffic. */
  configured: boolean;
  /** Revision currently being served. */
  revision: number | null;
  /** Why there is no bundle, or why the most recent reload was rejected. */
  lastError: string | null;
}

export interface BundleHolder {
  /** The bundle to serve this request with, or null when unconfigured. */
  current(): RuntimeBundle | null;
  status(): BundleStatus;
  /**
   * Validate `document`, build a bundle from it, and swap it in atomically.
   *
   * Never throws and never leaves the proxy worse off: a document that fails
   * validation or component construction is *rejected*, the previous bundle
   * keeps serving, and the reason comes back to the caller (an admin API turns
   * it into a 400). A bad configuration can therefore never take a running
   * proxy down.
   */
  reload(document: unknown, options?: { revision?: number }): Promise<ReloadResult>;
}

export interface BundleHolderDeps {
  registry: OmniRegistry;
  storage: StorageAdapter;
  engine: ExpressionEngine;
  /** Base runtime for component factories. */
  runtime: RuntimeContext;
  /** Overrides the per-bundle console logger. */
  logger?: Logger;
  /** Logger for the holder's own messages; defaults to `runtime.log`. */
  log?: Logger;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Holds the bundle currently being served and owns every transition to a new
 * one.
 *
 * The swap is a single reference assignment after the new bundle is fully
 * built, so there is no moment at which a request can observe a partially
 * applied configuration — no window where the new router is live but the old
 * limiter still is.
 */
export function createBundleHolder(deps: BundleHolderDeps): BundleHolder {
  let bundle: RuntimeBundle | null = null;
  let lastError: string | null = null;
  const log = deps.log ?? deps.runtime.log;

  return {
    current: () => bundle,

    status: () => ({
      configured: bundle !== null,
      revision: bundle?.revision ?? null,
      lastError,
    }),

    async reload(document, options = {}): Promise<ReloadResult> {
      const input: BuildBundleInput = {
        config: document,
        registry: deps.registry,
        storage: deps.storage,
        engine: deps.engine,
        runtime: deps.runtime,
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        revision: options.revision ?? null,
      };

      let next: RuntimeBundle;
      try {
        next = buildBundle(input);
      } catch (error) {
        lastError = errorMessage(error);
        log.error("configuration rejected; keeping the previous configuration", {
          revision: options.revision ?? null,
          configured: bundle !== null,
          error: lastError,
        });
        return { ok: false, error: lastError, kind: "invalid_config" };
      }

      const previous = bundle;
      bundle = next;
      lastError = null;
      log.info(previous === null ? "configuration loaded" : "configuration reloaded", {
        revision: next.revision,
        providers: next.providers.size,
        verifiers: next.verifiers.length,
        rateLimits: next.config.rateLimits.length,
      });
      return { ok: true, bundle: next };
    },
  };
}
