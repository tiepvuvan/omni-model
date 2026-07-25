/**
 * @omni-model/admin — the operator surface.
 *
 * Session authentication (Better Auth) plus HTTP access to the configuration,
 * credential and usage stores the proxy already owns. This package adds
 * authorization and transport, not mechanism.
 */
export * from "./app.js";
export * from "./auth.js";
export * from "./deps.js";
export * from "./session.js";
