import { describe, expect, it } from "vitest";
import { enrichGcpEnvironment } from "../src/gcp-metadata.js";

const METADATA_HOST = "metadata.test";
const PROJECT_ID = "omni-firebase-project";
const PROJECT_NUMBER = "1234567890";
const BASE_URL = `http://${METADATA_HOST}/computeMetadata/v1/project/`;

function metadataFetch(calls: string[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    expect(new Headers(init?.headers).get("Metadata-Flavor")).toBe("Google");
    if (url === `${BASE_URL}project-id`) return new Response(PROJECT_ID);
    if (url === `${BASE_URL}numeric-project-id`) return new Response(PROJECT_NUMBER);
    return new Response("not found", { status: 404 });
  };
}

const APP_CHECK_CONFIG = `
version: 1
security:
  providers:
    - type: firebase-app-check
`;

const FIRESTORE_CONFIG = `
version: 1
storage:
  type: firestore
`;

describe("enrichGcpEnvironment", () => {
  it("discovers the project id and number for an App Check Cloud Run deployment", async () => {
    const calls: string[] = [];
    const env = await enrichGcpEnvironment({
      configYaml: APP_CHECK_CONFIG,
      env: { GCE_METADATA_HOST: METADATA_HOST },
      fetch: metadataFetch(calls),
    });

    expect(env.GOOGLE_CLOUD_PROJECT).toBe(PROJECT_ID);
    expect(env.OMNI_GCP_PROJECT_NUMBER).toBe(PROJECT_NUMBER);
    expect(calls.sort()).toEqual([`${BASE_URL}numeric-project-id`, `${BASE_URL}project-id`]);
  });

  it("uses metadata before interpolating an explicit project-number reference", async () => {
    const calls: string[] = [];
    const env = await enrichGcpEnvironment({
      configYaml: `${APP_CHECK_CONFIG}      projectNumber: \${OMNI_GCP_PROJECT_NUMBER}\n`,
      env: { GCE_METADATA_HOST: METADATA_HOST },
      fetch: metadataFetch(calls),
    });

    expect(env.OMNI_GCP_PROJECT_NUMBER).toBe(PROJECT_NUMBER);
    expect(calls).not.toHaveLength(0);
  });

  it("discovers a project id for Firestore when no local project is configured", async () => {
    const env = await enrichGcpEnvironment({
      configYaml: FIRESTORE_CONFIG,
      env: { GCE_METADATA_HOST: METADATA_HOST },
      fetch: metadataFetch([]),
    });

    expect(env.GOOGLE_CLOUD_PROJECT).toBe(PROJECT_ID);
  });

  it("preserves explicit project values without contacting metadata", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("metadata should not be requested");
    };
    const env = await enrichGcpEnvironment({
      configYaml: APP_CHECK_CONFIG,
      env: {
        GOOGLE_CLOUD_PROJECT: "other-project",
        OMNI_GCP_PROJECT_NUMBER: "9876543210",
      },
      fetch: fetchImpl,
    });

    expect(env).toMatchObject({
      GOOGLE_CLOUD_PROJECT: "other-project",
      OMNI_GCP_PROJECT_NUMBER: "9876543210",
    });
  });

  it("does not contact metadata for a non-GCP configuration", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("metadata should not be requested");
    };
    const env = await enrichGcpEnvironment({
      configYaml: "version: 1\nstorage:\n  type: memory\n",
      env: {},
      fetch: fetchImpl,
    });

    expect(env).toEqual({});
  });

  it("does not delay a local Firestore emulator", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("metadata should not be requested");
    };
    const env = await enrichGcpEnvironment({
      configYaml: FIRESTORE_CONFIG,
      env: { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
      fetch: fetchImpl,
    });

    expect(env.FIRESTORE_EMULATOR_HOST).toBe("127.0.0.1:8080");
  });

  it("keeps startup portable when metadata is unavailable", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("metadata server unavailable");
    };
    const env = await enrichGcpEnvironment({
      configYaml: APP_CHECK_CONFIG,
      env: {},
      fetch: fetchImpl,
    });

    expect(env.OMNI_GCP_PROJECT_NUMBER).toBeUndefined();
  });
});
