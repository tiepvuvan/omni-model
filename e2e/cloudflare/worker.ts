// End-to-end worker for the Cloudflare suite. It is the *real* deployable
// worker — the same `createWorker` factory and `OmniStorageDurableObject` that
// ship in @omni-model/cloudflare and apps/cloudflare — with an OpenRouter-backed
// config bundled at build time. `wrangler dev` runs this in workerd so the e2e
// tests hit the genuine Workers runtime, not a Node stand-in.
// Imported from the built package (the same dist the deployed worker uses).
// A relative path — rather than the bare "@omni-model/cloudflare" specifier —
// keeps wrangler's bundler from having to resolve a workspace package from
// e2e/, which isn't a pnpm workspace member. Requires a prior `pnpm build`.
import { createWorker, OmniStorageDurableObject } from "../../packages/cloudflare/dist/index.js";
import configYaml from "./omni.e2e.worker.yaml";

export default createWorker({ configYaml });

// The DO class must be exported from the entry so the runtime can bind OMNI_DO.
export { OmniStorageDurableObject };
