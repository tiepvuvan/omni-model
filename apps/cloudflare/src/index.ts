import { createWorker, OmniStorageDurableObject } from "@omni-model/cloudflare";

/**
 * The deployable omni-model worker. Configuration comes entirely from
 * environment variables and secrets set in Workers.
 */
const worker = createWorker();

export default worker;
// The Durable Object class must be exported from the worker entry so the
// runtime can instantiate it (bound as OMNI_DO in wrangler.jsonc).
export { OmniStorageDurableObject };
