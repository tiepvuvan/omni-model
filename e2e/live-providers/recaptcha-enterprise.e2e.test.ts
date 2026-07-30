import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readOptionalLiveInput, readRequiredLiveInput } from "../support/live-inputs.js";
import {
  type LiveVerificationTarget,
  startLiveVerificationTarget,
} from "../support/live-verification.js";

const env = process.env;
const PROJECT_ID = nonEmpty(env.RECAPTCHA_ENTERPRISE_PROJECT_ID);
const ACTION = env.RECAPTCHA_ENTERPRISE_ACTION ?? "LOGIN";
const MIN_SCORE = parseScore(env.RECAPTCHA_ENTERPRISE_MIN_SCORE);
const credentials = credentialOptions();
const BASE_READY = PROJECT_ID !== undefined && credentials !== null;

type OriginField = "hostnames" | "androidPackageNames" | "iosBundleIds";

interface Platform {
  name: "Web" | "Android" | "iOS";
  slug: "web" | "android" | "ios";
  siteKey?: string;
  origin?: string;
  originField: OriginField;
  token?: string;
}

const platforms: Platform[] = [
  {
    name: "Web",
    slug: "web",
    siteKey: nonEmpty(env.RECAPTCHA_ENTERPRISE_WEB_SITE_KEY),
    origin: nonEmpty(env.RECAPTCHA_ENTERPRISE_WEB_HOSTNAME),
    originField: "hostnames",
    token: tokenFrom(env.RECAPTCHA_ENTERPRISE_WEB_TOKEN, env.RECAPTCHA_ENTERPRISE_WEB_TOKEN_FILE),
  },
  {
    name: "Android",
    slug: "android",
    siteKey: nonEmpty(env.RECAPTCHA_ENTERPRISE_ANDROID_SITE_KEY),
    origin: nonEmpty(env.RECAPTCHA_ENTERPRISE_ANDROID_PACKAGE_NAME),
    originField: "androidPackageNames",
    token: tokenFrom(
      env.RECAPTCHA_ENTERPRISE_ANDROID_TOKEN,
      env.RECAPTCHA_ENTERPRISE_ANDROID_TOKEN_FILE,
    ),
  },
  {
    name: "iOS",
    slug: "ios",
    siteKey: nonEmpty(env.RECAPTCHA_ENTERPRISE_IOS_SITE_KEY),
    origin: nonEmpty(env.RECAPTCHA_ENTERPRISE_IOS_BUNDLE_ID),
    originField: "iosBundleIds",
    token: tokenFrom(env.RECAPTCHA_ENTERPRISE_IOS_TOKEN, env.RECAPTCHA_ENTERPRISE_IOS_TOKEN_FILE),
  },
];

enforceRequiredPlatforms();

describe.skipIf(!BASE_READY)("E2E live provider: reCAPTCHA Enterprise", () => {
  for (const platform of platforms) {
    describe.skipIf(platform.siteKey === undefined)(`${platform.name} assessment`, () => {
      let target: LiveVerificationTarget;

      beforeAll(async () => {
        target = await startLiveVerificationTarget({
          type: "recaptcha-enterprise",
          projectId: PROJECT_ID,
          siteKey: platform.siteKey,
          expectedAction: ACTION,
          minScore: MIN_SCORE,
          ...credentials,
          ...(platform.origin === undefined ? {} : { [platform.originField]: [platform.origin] }),
        });
      });

      afterAll(async () => {
        await target?.stop();
      });

      it("reaches Google's assessment API and rejects an invalid token", {
        timeout: 30_000,
      }, async () => {
        const response = await target.request(
          "x-recaptcha-token",
          `intentionally-invalid-${platform.slug}-e2e-token`,
        );
        if (response.status === 503) {
          await response.body?.cancel();
          throw new Error(
            "Google assessment was unavailable. Grant the runtime identity " +
              "roles/recaptchaenterprise.agent on the configured project, confirm the " +
              "reCAPTCHA Enterprise API is enabled, and verify the key belongs to that project.",
          );
        }
        expect(response.status).toBe(401);
        expect(target.upstreamCalls()).toBe(0);
        await response.body?.cancel();
      });

      it.skipIf(platform.token === undefined || platform.origin === undefined)(
        "accepts a fresh SDK token, enforces its platform origin, and reaches routing",
        { timeout: 30_000 },
        async () => {
          const before = target.upstreamCalls();
          const response = await target.request("x-recaptcha-token", platform.token as string);
          if (response.status === 503) {
            await response.body?.cancel();
            throw new Error(
              "Google assessment was unavailable. Check the reCAPTCHA Enterprise Agent role " +
                "and run this test within two minutes of generating the one-time SDK token.",
            );
          }
          expect(response.status).toBe(200);
          expect(target.upstreamCalls()).toBe(before + 1);
          await expect(response.json()).resolves.toMatchObject({
            choices: [{ message: { content: "verified" } }],
          });
        },
      );
    });
  }
});

function parseScore(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error("RECAPTCHA_ENTERPRISE_MIN_SCORE must be a number from 0 through 1");
  }
  return score;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function tokenFrom(value: string | undefined, path: string | undefined): string | undefined {
  if (value !== undefined && value !== "") return value;
  return readOptionalLiveInput(path);
}

function credentialOptions(): Record<string, string> | null {
  const apiKey = env.RECAPTCHA_ENTERPRISE_API_KEY;
  const inlineServiceAccount = env.RECAPTCHA_ENTERPRISE_SERVICE_ACCOUNT_KEY;
  const serviceAccountPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  const configured = [
    apiKey !== undefined && apiKey !== "",
    inlineServiceAccount !== undefined && inlineServiceAccount !== "",
    serviceAccountPath !== undefined && serviceAccountPath !== "",
  ].filter(Boolean).length;
  if (configured > 1) {
    throw new Error(
      "Configure exactly one of RECAPTCHA_ENTERPRISE_API_KEY, " +
        "RECAPTCHA_ENTERPRISE_SERVICE_ACCOUNT_KEY, or GOOGLE_APPLICATION_CREDENTIALS",
    );
  }
  if (apiKey !== undefined && apiKey !== "") return { apiKey };
  if (inlineServiceAccount !== undefined && inlineServiceAccount !== "") {
    return { serviceAccountKey: inlineServiceAccount };
  }
  if (serviceAccountPath !== undefined && serviceAccountPath !== "") {
    return {
      serviceAccountKey: readRequiredLiveInput(
        serviceAccountPath,
        "GOOGLE_APPLICATION_CREDENTIALS",
      ),
    };
  }
  return null;
}

function enforceRequiredPlatforms(): void {
  const requested = (env.OMNI_E2E_REQUIRE_RECAPTCHA_PLATFORMS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const supported = new Set(platforms.map((platform) => platform.slug));
  for (const slug of requested) {
    if (!supported.has(slug as Platform["slug"])) {
      throw new Error(
        `OMNI_E2E_REQUIRE_RECAPTCHA_PLATFORMS contains unsupported platform "${slug}"`,
      );
    }
  }
  if (requested.length === 0) return;
  const missing: string[] = [];
  if (PROJECT_ID === undefined) missing.push("RECAPTCHA_ENTERPRISE_PROJECT_ID");
  if (credentials === null) {
    missing.push(
      "RECAPTCHA_ENTERPRISE_API_KEY or RECAPTCHA_ENTERPRISE_SERVICE_ACCOUNT_KEY or " +
        "GOOGLE_APPLICATION_CREDENTIALS",
    );
  }
  for (const platform of platforms.filter((entry) => requested.includes(entry.slug))) {
    if (platform.siteKey === undefined) {
      missing.push(`RECAPTCHA_ENTERPRISE_${platform.slug.toUpperCase()}_SITE_KEY`);
    }
    if (platform.origin === undefined) {
      missing.push(
        platform.slug === "web"
          ? "RECAPTCHA_ENTERPRISE_WEB_HOSTNAME"
          : platform.slug === "android"
            ? "RECAPTCHA_ENTERPRISE_ANDROID_PACKAGE_NAME"
            : "RECAPTCHA_ENTERPRISE_IOS_BUNDLE_ID",
      );
    }
    if (platform.token === undefined) {
      missing.push(
        `RECAPTCHA_ENTERPRISE_${platform.slug.toUpperCase()}_TOKEN or ` +
          `RECAPTCHA_ENTERPRISE_${platform.slug.toUpperCase()}_TOKEN_FILE`,
      );
    }
  }
  if (missing.length > 0) {
    throw new Error(`required live reCAPTCHA E2E input is missing: ${missing.join(", ")}`);
  }
}
