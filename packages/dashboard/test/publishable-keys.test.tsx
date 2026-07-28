import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishableKey } from "../src/lib/api";
import { createFakeApi, type FakeApi } from "./support/fake-api";
import { dialog, renderAt } from "./support/render";

const NOW = Date.UTC(2026, 6, 27, 9, 0, 0);

function key(overrides: Partial<PublishableKey> = {}): PublishableKey {
  return {
    id: "key-ios",
    name: "iOS production",
    prefix: "omk_test",
    last4: "7abc",
    allowedModels: null,
    captureContent: null,
    metadata: {},
    createdBy: "ops@example.test",
    createdAt: NOW - 86_400_000,
    expiresAt: null,
    disabledAt: null,
    usage: {
      totalTokens: 710_983,
      lastUsedAt: NOW - 30_000,
      lastModel: "gpt-4o-mini",
    },
    ...overrides,
  };
}

describe("publishable keys", () => {
  let fake: FakeApi;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    fake = createFakeApi({ writeKeys: [key()] });
    fake.install();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("matches the Figma list and reports usage", async () => {
    await renderAt("/publishable-keys");

    expect(screen.getByRole("heading", { name: "Public API Keys" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Publishable keys" });
    for (const heading of [
      "Reference name",
      "Expire",
      "Total tokens",
      "Last used",
      "Request time",
    ]) {
      expect(within(table).getByRole("columnheader", { name: heading })).toBeInTheDocument();
    }
    expect(within(table).getByText("iOS production")).toBeInTheDocument();
    expect(within(table).getByText("710,983 tokens")).toBeInTheDocument();
    expect(within(table).getByText("gpt-4o-mini")).toBeInTheDocument();
    expect(within(table).getByText("30 seconds ago")).toBeInTheDocument();
  });

  it("generates a named key, copies it, and never lists its plaintext", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await renderAt("/publishable-keys");

    await user.click(screen.getByRole("button", { name: "Public API Key" }));
    const panel = dialog();
    await user.type(panel.getByLabelText("Reference name"), "Android staging");
    await user.click(panel.getByRole("button", { name: "Generate" }));

    const secret = "omk_test_secret_key-2";
    expect(await panel.findByText(secret)).toBeInTheDocument();
    expect(fake.callsTo("POST", "/write-keys")).toEqual([
      expect.objectContaining({ body: { name: "Android staging" } }),
    ]);
    await user.click(panel.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(secret);
    expect(panel.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    await user.click(panel.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Android staging")).toBeInTheDocument();
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
  });

  it("revokes a key after confirmation", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const user = userEvent.setup();
    await renderAt("/publishable-keys");

    await user.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(fake.callsTo("DELETE", "/write-keys/key-ios")).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Revoked" })).toBeDisabled();
    });
  });

  it("documents the OpenAI-compatible and user-token headers", async () => {
    const user = userEvent.setup();
    await renderAt("/publishable-keys");

    await user.click(screen.getByRole("tab", { name: "Instruction" }));

    expect(screen.getByText(/Authorization: Bearer/)).toBeInTheDocument();
    expect(screen.getByText(/X-Firebase-ID-Token/)).toBeInTheDocument();
    expect(screen.getByText(/X-Clerk-Session-Token/)).toBeInTheDocument();
  });
});
