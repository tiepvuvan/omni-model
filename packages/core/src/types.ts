/** Minimal logging interface. Implementations decide where log lines go. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Runtime services injected into every pluggable component (auth verifiers,
 * model providers, storage factories). Abstracts over Node, Cloudflare
 * Workers and other fetch-based runtimes so core stays runtime-agnostic.
 */
export interface RuntimeContext {
  /** Environment variables / platform secrets. */
  env: Record<string, string | undefined>;
  /** Platform fetch. Components must call this instead of the global. */
  fetch: typeof fetch;
  /** Current epoch time in milliseconds. Injectable for tests. */
  now(): number;
  /**
   * Schedule work to continue after the response has been sent
   * (`ctx.waitUntil` on Workers, fire-and-forget on Node).
   */
  waitUntil(promise: Promise<unknown>): void;
  log: Logger;
}
