import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authHeaders } from "./support/auth.js";
import { type RunningTarget, startNodeTarget } from "./support/proxy-targets.js";

/**
 * End-to-end: the Node server with **Firestore** storage (the Cloud Run
 * backend), against the Firestore **emulator**. Proves two things the other
 * suites can't: that `@omni-model/node` actually wires the Firestore adapter
 * (via firebase-admin), and that rate-limit counters increment and persist in
 * Firestore through the full request pipeline.
 *
 * A short burst against a low limit must produce a 429 — impossible unless the
 * Firestore counter genuinely increments (rate limiting is fail-open, so a
 * broken store would let every request through). The upstream is never needed:
 * a 429 is returned before routing.
 *
 * Opt-in: run under the emulator, which sets `FIRESTORE_EMULATOR_HOST`:
 *   firebase emulators:exec --only firestore --project omni-e2e \
 *     'pnpm exec vitest run --config vitest.e2e.config.ts e2e/storage-firestore.e2e.test.ts'
 */
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const READY = Boolean(EMULATOR);

const configYaml = readFileSync(
  fileURLToPath(new URL("./omni.firestore.e2e.yaml", import.meta.url)),
  "utf8",
);

describe.skipIf(!READY)("E2E: Node + Firestore storage (emulator)", () => {
  let proxy: RunningTarget;

  beforeAll(async () => {
    proxy = await startNodeTarget(configYaml, {
      ...process.env,
      // firebase-admin needs a project id even against the emulator.
      GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT ?? "omni-e2e",
    });
  }, 30_000);

  afterAll(async () => {
    await proxy?.stop();
  });

  it("boots with Firestore storage and serves /healthz", async () => {
    const res = await fetch(`${proxy.base}/healthz`);
    expect(res.status).toBe(200);
  });

  it("enforces the rate limit from Firestore counters (burst trips a 429)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${proxy.base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
      });
      statuses.push(res.status);
      await res.body?.cancel();
    }
    // limit is 3/min on ip: the first few pass the limit, later ones are 429.
    expect(statuses, `statuses: ${statuses.join(",")}`).toContain(429);
    expect(
      statuses.some((s) => s !== 429),
      `statuses: ${statuses.join(",")}`,
    ).toBe(true);
  });
});
