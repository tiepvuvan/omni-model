import { createWorker, OmniStorageDurableObject } from "@omni-model/cloudflare";

/**
 * Entry for the **prebuilt worker artifact** — the forkless deploy path.
 *
 * This is the Cloudflare analogue of the GHCR image: consumers download one
 * immutable `worker.js` and `wrangler deploy` it, with no fork, no clone and no
 * build. Updates are a re-download + redeploy.
 *
 * The one difference from `index.ts` (the fork-and-edit entry) is what is NOT
 * here: no `import configYaml from "../omni.yaml"`. That import is what makes
 * wrangler emit the config as a *separate hashed sidecar* file, which would
 * make the release artifact two coupled files with a build-dependent name.
 * Without it the bundle is a single self-contained script, and configuration
 * arrives at runtime through the `OMNI_CONFIG` var — exactly how the container
 * image takes its config.
 *
 * `createWorker()` with no `configYaml` is a supported shape: it resolves
 * `OMNI_CONFIG` from the environment, and throws a ConfigError naming the fix
 * when neither is present.
 */
const worker = createWorker();

export default worker;
// The Durable Object class must be exported from the entry so the runtime can
// bind OMNI_DO (declared in the deployer's wrangler.jsonc).
export { OmniStorageDurableObject };
