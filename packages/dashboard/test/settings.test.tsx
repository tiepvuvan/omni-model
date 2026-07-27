import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeApi, type FakeApi } from "./support/fake-api";
import { renderAt, selectOption } from "./support/render";

let fake: FakeApi;

beforeEach(() => {
  fake = createFakeApi({
    config: {
      server: { maxInputTokens: 64_000, logLevel: "warn" },
      cache: { enabled: true, ttl: "1h", maxEntries: 10_000 },
    },
    cache: { available: true, entries: 42, oldestAt: 1_700_000_000_000, bytes: 2048 },
  });
  fake.install();
});

/** The `cache` block the last save sent. */
function lastCache(): Record<string, unknown> {
  const calls = fake.callsTo("PATCH", "/config");
  const body = calls[calls.length - 1]?.body as
    | { value: { cache: Record<string, unknown> } }
    | undefined;
  if (body === undefined) throw new Error("nothing was saved");
  return body.value.cache;
}

/** The `server` block the last save sent. */
function lastServer(): Record<string, unknown> {
  const calls = fake.callsTo("PATCH", "/config");
  const body = calls[calls.length - 1]?.body as
    | { value: { server: Record<string, unknown> } }
    | undefined;
  if (body === undefined) throw new Error("nothing was saved");
  return body.value.server;
}

const save = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => {
    expect(fake.callsTo("PATCH", "/config").length).toBeGreaterThan(0);
  });
};

function card(title: string): HTMLElement {
  const section = screen.getByText(title).closest("section");
  if (section === null) throw new Error(`no card for ${title}`);
  return section;
}

describe("settings", () => {
  it("shows the applied settings and what is actually stored", async () => {
    await renderAt("/settings");

    expect(
      within(card("Request limits")).getByLabelText("Maximum input tokens per request"),
    ).toHaveValue("64,000");
    expect(within(card("Response cache")).getByRole("switch")).toBeChecked();
    expect(within(card("Response cache")).getByLabelText("Keep an answer for")).toHaveTextContent(
      "1 hour",
    );
    expect(within(card("Response cache")).getByLabelText("Entries to keep")).toHaveValue("10,000");
    // Both halves, so an operator does not have to cross-reference the config with
    // the contents to know whether caching is doing anything.
    expect(card("What is cached now")).toHaveTextContent("42 entries");
    expect(card("What is cached now")).toHaveTextContent("2 KB");
  });

  it("saves the whole block in one revision", async () => {
    const user = userEvent.setup();
    await renderAt("/settings");

    await selectOption(user, /Keep an answer for/, "1 day");
    await save(user);

    // One PATCH, not one PUT per field: a half-applied change would leave the TTL
    // and the size disagreeing about what the operator asked for.
    expect(fake.callsTo("PATCH", "/config")).toHaveLength(1);
    expect(lastCache()).toEqual({ enabled: true, ttl: "1d", maxEntries: 10_000 });
    expect(lastServer()).toEqual({ maxInputTokens: 64_000, logLevel: "warn" });
  });

  it("updates the token limit without dropping other server settings", async () => {
    const user = userEvent.setup();
    await renderAt("/settings");

    const limit = within(card("Request limits")).getByLabelText("Maximum input tokens per request");
    await user.clear(limit);
    await user.type(limit, "256000");
    await save(user);

    expect(lastServer()).toEqual({ maxInputTokens: 256_000, logLevel: "warn" });
    expect(fake.callsTo("PATCH", "/config")).toHaveLength(1);
  });

  it("turns caching off without touching what is stored", async () => {
    const user = userEvent.setup();
    await renderAt("/settings");

    await user.click(within(card("Response cache")).getByRole("switch"));
    await save(user);

    expect(lastCache()).toMatchObject({ enabled: false });
    // Switching off is not purging: the entries are still there, and still purgeable.
    expect(fake.state.cache.entries).toBe(42);
  });

  it("purges on request and says how many went", async () => {
    const user = userEvent.setup();
    await renderAt("/settings");

    await user.click(screen.getByRole("button", { name: "Purge everything" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Purged 42 entries");
    expect(fake.callsTo("DELETE", "/cache")).toHaveLength(1);
  });

  it("offers nothing to purge when nothing is cached", async () => {
    fake = createFakeApi({
      config: { cache: { enabled: true, ttl: "1h", maxEntries: 10 } },
      cache: { available: true, entries: 0, oldestAt: null, bytes: 0 },
    });
    fake.install();
    await renderAt("/settings");

    expect(card("What is cached now")).toHaveTextContent("Nothing is cached");
    expect(screen.getByRole("button", { name: "Purge everything" })).toBeDisabled();
  });

  it("says so when the deployment has nowhere to cache", async () => {
    fake = createFakeApi({
      config: { cache: { enabled: true, ttl: "1h", maxEntries: 10 } },
      cache: { available: false, entries: 0, oldestAt: null, bytes: null },
    });
    fake.install();
    await renderAt("/settings");

    // Enabling a cache with no backend is a setting that quietly does nothing,
    // which is worse than a setting that refuses.
    expect(await screen.findByRole("status")).toHaveTextContent("nowhere to cache");
  });

  it("shows the schema's defaults when the block is absent", async () => {
    fake = createFakeApi({
      config: {},
      cache: { available: true, entries: 0, oldestAt: null, bytes: null },
    });
    fake.install();
    await renderAt("/settings");

    // On, five minutes, ten thousand — what the proxy would actually do, so an
    // absent block never reads as an absent feature.
    expect(within(card("Response cache")).getByRole("switch")).toBeChecked();
    expect(within(card("Response cache")).getByLabelText("Keep an answer for")).toHaveTextContent(
      "5 minutes",
    );
    expect(within(card("Response cache")).getByLabelText("Entries to keep")).toHaveValue("10,000");
    expect(
      within(card("Request limits")).getByLabelText("Maximum input tokens per request"),
    ).toHaveValue("128,000");
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });
});
