import { type RunningServer, startServer } from "@omni-model/node";

/**
 * Helper to stand up the omni-model proxy behind a `{ base, stop }` interface.
 * The container (`@omni-model/node`) is the only deploy target, so there is one
 * implementation; the indirection stays because suites read better when the
 * target is named, and it keeps port/lifecycle handling in one place.
 */
export interface RunningTarget {
  /** Base URL, e.g. http://127.0.0.1:8801 */
  base: string;
  stop: () => Promise<void>;
}

/** Boot the Node server with a JSON configuration document. */
export async function startNodeTarget(
  configJson: string,
  env: NodeJS.ProcessEnv,
): Promise<RunningTarget> {
  const server: RunningServer = await startServer({
    config: JSON.parse(configJson) as Record<string, unknown>,
    env,
    port: 0,
    hostname: "127.0.0.1",
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    stop: () => server.close(),
  };
}
