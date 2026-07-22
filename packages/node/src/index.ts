/**
 * @omni-model/node — Node.js server entry for omni-model (Docker, Fly.io,
 * Cloud Run, bare Node). `startServer` runs the proxy programmatically;
 * `resolveConfigSource` implements the CLI's environment-first config lookup
 * order.
 */
export * from "./config.js";
export * from "./server.js";
