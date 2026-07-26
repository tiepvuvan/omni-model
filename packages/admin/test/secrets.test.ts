import { describe, expect, it } from "vitest";
import { baseConfig, createTestAdmin, errorOf } from "./helpers.js";

const VALUE = "sk-live-do-not-log-this-value";

interface Description {
  id: string;
  name: string;
  hint: string;
  fingerprint: string;
}

async function store(
  call: Awaited<ReturnType<typeof createTestAdmin>>["call"],
  name = "openai",
  value = VALUE,
): Promise<Description> {
  const response = await call("/admin/api/secrets", {
    method: "PUT",
    body: JSON.stringify({ name, value }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { secret: Description }).secret;
}

describe("secrets are write-only", () => {
  it("returns a description, never the value", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const description = await store(call);
    expect(description.hint).not.toContain(VALUE);
    expect(description.fingerprint).not.toContain(VALUE);

    for (const path of ["/admin/api/secrets", `/admin/api/secrets/${description.id}`]) {
      const body = await (await call(path)).text();
      expect(body).not.toContain(VALUE);
      // Not even a prefix long enough to be useful.
      expect(body).not.toContain(VALUE.slice(0, 12));
    }
  });

  it("explains why the value cannot be read back", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const description = await store(call);
    const response = await call(`/admin/api/secrets/${description.id}/value`);
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe("secrets_are_write_only");
    expect(error.message).not.toContain(VALUE);
  });

  it("keeps the id when a value is replaced, so references stay valid", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const first = await store(call, "openai", "sk-old");
    const second = await store(call, "openai", "sk-new");
    expect(second.id).toBe(first.id);
    // A different value must be visibly different, or a rotation cannot be verified.
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it("re-seals every secret on rotate", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    await store(call, "one");
    await store(call, "two");
    const response = await call("/admin/api/secrets/rotate", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rotated: 0, total: 2 });
  });

  it("404s for a secret that does not exist", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    expect((await call("/admin/api/secrets/nope")).status).toBe(404);
    expect((await call("/admin/api/secrets/nope", { method: "DELETE" })).status).toBe(404);
  });

  it("503s with the variable to set when no master key is configured", async () => {
    const { call } = await createTestAdmin({ config: baseConfig(), withSecrets: false });
    const response = await call("/admin/api/secrets");
    expect(response.status).toBe(503);
    const error = await errorOf(response);
    expect(error.code).toBe("secrets_unavailable");
    expect(error.message).toMatch(/OMNI_ENCRYPTION_KEY/);
  });
});

describe("deleting a referenced secret", () => {
  /** A configuration whose provider key is a `$secret` reference. */
  const referencing = (id: string): Record<string, unknown> =>
    baseConfig({
      routing: {
        rules: [
          {
            id: "default",
            when: "true",
            target: {
              type: "openai",
              apiKey: { $secret: id },
              baseUrl: "https://upstream.test/v1",
            },
          },
        ],
      },
    });

  it("refuses, because the failure would only appear on the next reload", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const description = await store(call);
    const saved = await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: referencing(description.id) }),
    });
    expect(saved.status).toBe(200);

    const response = await call(`/admin/api/secrets/${description.id}`, { method: "DELETE" });
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("secret_in_use");
    expect(error.message).toMatch(/force=true/);
  });

  it("allows it when the caller says they mean it", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const description = await store(call);
    await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: referencing(description.id) }),
    });
    const response = await call(`/admin/api/secrets/${description.id}?force=true`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
  });

  it("allows it once nothing references it", async () => {
    const { call } = await createTestAdmin({ config: baseConfig() });
    const description = await store(call);
    await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: referencing(description.id) }),
    });
    // Back to a literal key.
    await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: baseConfig() }),
    });
    expect((await call(`/admin/api/secrets/${description.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
  });
});

describe("secret references reach the provider", () => {
  it("applies a configuration whose credential is a reference", async () => {
    const { call, holder } = await createTestAdmin({ config: baseConfig() });
    const description = await store(call);
    const response = await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        config: baseConfig({
          routing: {
            rules: [
              {
                id: "default",
                when: "true",
                target: {
                  type: "openai",
                  apiKey: { $secret: description.id },
                  baseUrl: "https://upstream.test/v1",
                },
              },
            ],
          },
        }),
      }),
    });
    expect(response.status).toBe(200);
    expect(holder.status().configured).toBe(true);
    // The stored revision keeps the reference; only the live bundle holds the value.
    expect(JSON.stringify((await response.json()) as unknown)).not.toContain(VALUE);
  });

  it("rejects a reference to a secret that does not exist, naming the path", async () => {
    const { call, holder } = await createTestAdmin({ config: baseConfig() });
    const response = await call("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        config: baseConfig({
          routing: {
            rules: [
              {
                id: "default",
                when: "true",
                target: {
                  type: "openai",
                  apiKey: { $secret: "00000000-0000-0000-0000-000000000000" },
                  baseUrl: "https://upstream.test/v1",
                },
              },
            ],
          },
        }),
      }),
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/routing\.rules\[0\]\.target\.apiKey/);
    expect(holder.status().revision).toBe(1);
  });
});
