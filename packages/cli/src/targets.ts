/**
 * Deploy targets and the storage backends each one can actually reach.
 *
 * This is data, not prose: the wizard offers only combinations that work, so a
 * user can't pick Firestore on Cloudflare (no firebase-admin at the edge) or a
 * Durable Object on Fly.io. Pure and exported so it can be exhaustively tested.
 */

export type TargetId = "cloudflare" | "cloud-run" | "fly" | "render" | "docker";

export type StorageId =
  | "durable-object"
  | "cloudflare-kv"
  | "firestore"
  | "redis"
  | "postgres"
  | "memory";

export interface StorageInfo {
  id: StorageId;
  label: string;
  hint: string;
}

export const STORAGE: Record<StorageId, StorageInfo> = {
  "durable-object": {
    id: "durable-object",
    label: "Durable Object",
    hint: "exact counters, free-plan friendly — the default on Workers",
  },
  "cloudflare-kv": {
    id: "cloudflare-kv",
    label: "Workers KV",
    hint: "cheap + global, but eventually consistent so counts are approximate",
  },
  firestore: {
    id: "firestore",
    label: "Firestore",
    hint: "serverless, nothing to provision — the natural pick on Cloud Run",
  },
  redis: { id: "redis", label: "Redis", hint: "exact + fast; needs a Redis URL" },
  postgres: { id: "postgres", label: "Postgres", hint: "exact; needs a database URL" },
  memory: {
    id: "memory",
    label: "In-memory",
    hint: "no shared state — limits apply per instance only",
  },
};

export interface TargetInfo {
  id: TargetId;
  label: string;
  hint: string;
  /** Storage backends this target can actually run. First is the default. */
  storages: StorageId[];
  /** The external tool the deploy shells out to. */
  tool: string;
}

export const TARGETS: Record<TargetId, TargetInfo> = {
  cloudflare: {
    id: "cloudflare",
    label: "Cloudflare Workers",
    hint: "edge, forkless — downloads a prebuilt worker, no build",
    storages: ["durable-object", "cloudflare-kv"],
    tool: "wrangler",
  },
  "cloud-run": {
    id: "cloud-run",
    label: "Google Cloud Run",
    hint: "serverless container + Firestore",
    storages: ["firestore", "redis", "postgres", "memory"],
    tool: "gcloud",
  },
  fly: {
    id: "fly",
    label: "Fly.io",
    hint: "container, global",
    storages: ["redis", "postgres", "memory"],
    tool: "flyctl",
  },
  render: {
    id: "render",
    label: "Render",
    hint: "container + managed Key Value",
    storages: ["redis", "postgres"],
    tool: "render",
  },
  docker: {
    id: "docker",
    label: "Docker (run locally)",
    hint: "try it on this machine first",
    storages: ["memory", "redis", "postgres"],
    tool: "docker",
  },
};

/** Storage options valid for a target; the first entry is the default. */
export function storagesFor(target: TargetId): StorageInfo[] {
  return TARGETS[target].storages.map((id) => STORAGE[id]);
}

/** Targets that run the container image rather than the edge bundle. */
export function isContainerTarget(target: TargetId): boolean {
  return target !== "cloudflare";
}
