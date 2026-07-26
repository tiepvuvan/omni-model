import { describe, expect, it, vi } from "vitest";
import { baseConfig, createTestAdmin, errorOf } from "./helpers.js";

/**
 * `POST /providers/models` — list what a candidate target can serve.
 *
 * The dashboard calls this while an operator is typing an API key, so it does two
 * jobs: populate the model dropdown, and prove the key works *before* it is saved.
 * The existing per-rule probe cannot do that — it answers for the applied bundle,
 * which by definition does not contain a key that has not been saved yet.
 */
interface ModelsResponse {
  ok: boolean | null;
  models: string[];
  status?: number | null;
  error?: string | null;
  reason?: string;
}

/** An upstream that answers `/models` with a catalogue. */
function upstreamServing(...models: string[]): typeof fetch {
  return vi.fn(async () =>
    Response.json({ data: models.map((id) => ({ id, object: "model" })) }),
  ) as unknown as typeof fetch;
}

const ask = async (
  admin: Awaited<ReturnType<typeof createTestAdmin>>,
  target: Record<string, unknown>,
) =>
  admin.call("/admin/api/providers/models", {
    method: "POST",
    body: JSON.stringify({ target }),
    headers: { "content-type": "application/json" },
  });

describe("listing a candidate target's models", () => {
  it("returns what the upstream serves for a key that works", async () => {
    const admin = await createTestAdmin({
      config: baseConfig(),
      fetch: upstreamServing("gpt-4o", "gpt-4o-mini"),
    });

    const response = await ask(admin, { type: "openai", apiKey: "sk-good" });
    const body = (await response.json()) as ModelsResponse;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("reports a refused key as a failure rather than an empty catalogue", async () => {
    // The bug this guards is the same one the per-rule probe had: `listModels`
    // falls back to the configured model list on any failure, so trusting its
    // return value reports a dead key as a healthy upstream with no models.
    const admin = await createTestAdmin({
      config: baseConfig(),
      fetch: vi.fn(async () =>
        Response.json({ error: { message: "Incorrect API key" } }, { status: 401 }),
      ) as unknown as typeof fetch,
    });

    const body = (await (
      await ask(admin, { type: "openai", apiKey: "sk-bad" })
    ).json()) as ModelsResponse;

    expect(body.ok).toBe(false);
    expect(body.status).toBe(401);
    expect(body.models).toEqual([]);
  });

  it("reports a network failure as a failure", async () => {
    const admin = await createTestAdmin({
      config: baseConfig(),
      fetch: vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND api.example.invalid");
      }) as unknown as typeof fetch,
    });

    const body = (await (
      await ask(admin, { type: "openai-compatible", baseUrl: "https://api.example.invalid/v1" })
    ).json()) as ModelsResponse;

    expect(body.ok).toBe(false);
    expect(body.error).toContain("ENOTFOUND");
  });

  it("is a 200 either way, because refusal is a real answer", async () => {
    // "Is this key good" is a question that succeeds even when the answer is no.
    // A 4xx here would make the dashboard treat a wrong key as a broken request.
    const admin = await createTestAdmin({
      config: baseConfig(),
      fetch: vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
    });

    const response = await ask(admin, { type: "openai", apiKey: "sk-forbidden" });

    expect(response.status).toBe(200);
  });

  it("ignores `model`, which is the rule's choice and not a provider option", async () => {
    // The factories validate with `strictObject`; passing `model` through would be
    // rejected as an unrecognised key — the defect that only showed on a container.
    const admin = await createTestAdmin({
      config: baseConfig(),
      fetch: upstreamServing("gpt-4o"),
    });

    const body = (await (
      await ask(admin, { type: "openai", apiKey: "sk-good", model: "gpt-4o" })
    ).json()) as ModelsResponse;

    expect(body.ok).toBe(true);
  });

  it("rejects an unknown provider type as a bad request", async () => {
    const admin = await createTestAdmin({ config: baseConfig() });

    const response = await ask(admin, { type: "not-a-provider", apiKey: "x" });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("not-a-provider");
  });

  it("turns the operator's own bad input into a 400, not a 500", async () => {
    // `openai-compatible` has no default endpoint, so omitting `baseUrl` is a
    // `ConfigError` from the factory — which is the operator's input being wrong.
    const admin = await createTestAdmin({ config: baseConfig() });

    const response = await ask(admin, { type: "openai-compatible" });

    expect(response.status).toBe(400);
  });
});
