import { createWorker, OmniStorageDurableObject } from "@omni-model/cloudflare";

/**
 * Entry for the **prebuilt worker artifact** — the forkless deploy path.
 *
 * This is the Cloudflare analogue of the GHCR image: consumers download one
 * immutable `worker.js` and `wrangler deploy` it, with no fork, no clone and no
 * build. Updates are a re-download + redeploy.
 *
 * The bundle is a single self-contained script, and configuration arrives at
 * runtime through environment variables — exactly how the container image
 * takes its config.
 *
 * `createWorker()` throws a ConfigError naming the environment-variable fix
 * when no configuration is present.
 */
const worker = createWorker();

export default worker;
// The Durable Object class must be exported from the entry so the runtime can
// bind OMNI_DO (declared in the deployer's wrangler.jsonc).
export { OmniStorageDurableObject };
