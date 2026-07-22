/** Cloud Run / Compute Engine metadata server root. */
const DEFAULT_METADATA_HOST = "metadata.google.internal";
const METADATA_PREFIX = "/computeMetadata/v1/project/";
const METADATA_TIMEOUT_MS = 500;

const FIRESTORE_TYPE = /(?:^|\n)\s*type\s*:\s*["']?firestore["']?\s*(?:#.*)?$/m;
const APP_CHECK_TYPE = /(?:^|\n)\s*(?:-\s*)?type\s*:\s*["']?firebase-app-check["']?\s*(?:#.*)?$/m;
const PROJECT_NUMBER_FIELD = /(?:^|\n)\s*projectNumber\s*:/m;
const PROJECT_ID_REFERENCE = /\$\{GOOGLE_CLOUD_PROJECT(?::-[^}]*)?\}/;
const PROJECT_NUMBER_REFERENCE = /\$\{OMNI_GCP_PROJECT_NUMBER(?::-[^}]*)?\}/;

/** Arguments for {@link enrichGcpEnvironment}. */
export interface GcpEnvironmentOptions {
  /** Raw configuration document, used to avoid metadata requests when GCP values are irrelevant. */
  configYaml: string;
  /** Existing environment values. They are never mutated. */
  env: Record<string, string | undefined>;
  /** Fetch implementation, injectable for deterministic tests. */
  fetch: typeof fetch;
}

function requiresGcpMetadata(options: GcpEnvironmentOptions): boolean {
  const { configYaml, env } = options;
  if (PROJECT_ID_REFERENCE.test(configYaml) && env.GOOGLE_CLOUD_PROJECT === undefined) return true;
  if (PROJECT_NUMBER_REFERENCE.test(configYaml) && env.OMNI_GCP_PROJECT_NUMBER === undefined) {
    return true;
  }
  const hasFirestoreProjectId =
    env.GOOGLE_CLOUD_PROJECT !== undefined ||
    env.FIREBASE_PROJECT_ID !== undefined ||
    env.GCLOUD_PROJECT !== undefined;
  if (
    FIRESTORE_TYPE.test(configYaml) &&
    hasFirestoreProjectId === false &&
    env.FIRESTORE_EMULATOR_HOST === undefined
  ) {
    return true;
  }
  return (
    APP_CHECK_TYPE.test(configYaml) &&
    PROJECT_NUMBER_FIELD.test(configYaml) === false &&
    env.OMNI_GCP_PROJECT_NUMBER === undefined
  );
}

function metadataUrl(env: Record<string, string | undefined>, path: string): string {
  const host = env.GCE_METADATA_HOST ?? DEFAULT_METADATA_HOST;
  return `http://${host}${METADATA_PREFIX}${path}`;
}

async function readMetadata(
  path: string,
  options: Pick<GcpEnvironmentOptions, "env" | "fetch">,
): Promise<string | undefined> {
  try {
    const response = await options.fetch(metadataUrl(options.env, path), {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const value = (await response.text()).trim();
    return value === "" ? undefined : value;
  } catch {
    // A local container has no metadata server. The caller either has explicit
    // configuration or the relevant verifier will explain which value is missing.
    return undefined;
  }
}

/**
 * Add Google Cloud project metadata to a copy of `env` when the configuration
 * needs it. Cloud Run and Compute Engine expose these values without a service
 * account key; local and non-GCP deployments simply retain their original env.
 *
 * `GOOGLE_CLOUD_PROJECT` is a conventional project-id variable. The numeric
 * project number is exposed as `OMNI_GCP_PROJECT_NUMBER` so App Check YAML can
 * omit `projectNumber` on GCP while retaining an explicit cross-project escape
 * hatch. Caller-provided values always win over metadata.
 */
export async function enrichGcpEnvironment(
  options: GcpEnvironmentOptions,
): Promise<Record<string, string | undefined>> {
  const env = { ...options.env };
  if (!requiresGcpMetadata({ ...options, env })) return env;

  const [projectId, projectNumber] = await Promise.all([
    env.GOOGLE_CLOUD_PROJECT === undefined
      ? readMetadata("project-id", { env, fetch: options.fetch })
      : undefined,
    env.OMNI_GCP_PROJECT_NUMBER === undefined
      ? readMetadata("numeric-project-id", { env, fetch: options.fetch })
      : undefined,
  ]);

  if (env.GOOGLE_CLOUD_PROJECT === undefined && projectId !== undefined) {
    env.GOOGLE_CLOUD_PROJECT = projectId;
  }
  if (
    env.OMNI_GCP_PROJECT_NUMBER === undefined &&
    projectNumber !== undefined &&
    /^\d+$/.test(projectNumber)
  ) {
    env.OMNI_GCP_PROJECT_NUMBER = projectNumber;
  }
  return env;
}
