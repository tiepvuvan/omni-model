import { createWorker, OmniStorageDurableObject } from "@omni-model/cloudflare";
import configYaml from "../omni.yaml";

/**
 * The deployable omni-model worker. `omni.yaml` (next to this app) is
 * bundled at deploy time as the default configuration; setting the
 * `OMNI_CONFIG` secret/var to a YAML document overrides it without a
 * rebuild.
 */
const worker = createWorker({ configYaml });

export default worker;
// The Durable Object class must be exported from the worker entry so the
// runtime can instantiate it (bound as OMNI_DO in wrangler.jsonc).
export { OmniStorageDurableObject };
