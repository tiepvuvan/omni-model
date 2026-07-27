import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestLog } from "../src/lib/api";
import { createFakeApi, type FakeApi } from "./support/fake-api";
import { dialog, renderAt } from "./support/render";

const NOW = Date.UTC(2026, 6, 27, 9, 0, 0);

function requestLog(overrides: Partial<RequestLog> = {}): RequestLog {
  return {
    id: "row-1",
    requestId: "req-activity-1",
    ts: NOW - 30_000,
    writeKeyId: "client-1",
    writeKeyName: "iOS - Dev env",
    userId: "user-42",
    deviceId: "device-9",
    authProvider: "clerk",
    modelRequested: "smart",
    modelRouted: "4o-mini",
    providerId: "openai-compatible",
    routeName: "fast",
    stream: true,
    status: 200,
    errorCode: null,
    rateLimitRule: null,
    cached: false,
    promptTokens: 1_827,
    completionTokens: 572,
    totalTokens: 2_399,
    latencyMs: 1_240,
    ttfbMs: 180,
    ip: "203.0.113.4",
    userAgent: "OmniModelClient/1.0",
    content: {
      messages: [{ role: "user", content: "Summarize this request" }],
      headers: {
        authorization: "[REDACTED]",
        "content-type": "application/json",
        "x-omni-key": "[REDACTED]",
      },
      body: {
        model: "smart",
        messages: [{ role: "user", content: "Summarize this request" }],
        stream: true,
      },
      completion: "Here is the summary.",
      truncated: false,
    },
    ...overrides,
  };
}

describe("activity logs", () => {
  let fake: FakeApi;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    fake = createFakeApi({ logs: [requestLog()] });
    fake.install();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("matches the Figma table and formats request activity", async () => {
    await renderAt("/logs");

    expect(screen.getByRole("heading", { name: "Activity Logs" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Activity logs" });
    for (const heading of [
      "Client",
      "Status",
      "Routed model",
      "Output tokens",
      "Input tokens",
      "Request time",
    ]) {
      expect(within(table).getByRole("columnheader", { name: heading })).toBeInTheDocument();
    }
    expect(within(table).getByText("iOS - Dev env")).toBeInTheDocument();
    expect(within(table).getByText("Authenticated")).toBeInTheDocument();
    expect(within(table).getByText("4o-mini")).toBeInTheDocument();
    expect(within(table).getByText("572 tokens")).toBeInTheDocument();
    expect(within(table).getByText("1,827 tokens")).toBeInTheDocument();
    expect(within(table).getByText("30 seconds ago")).toBeInTheDocument();
  });

  it("opens a right-side modal with every stored request detail", async () => {
    const user = userEvent.setup();
    await renderAt("/logs");

    await user.click(screen.getByText("iOS - Dev env"));

    const panel = dialog();
    expect(panel.getByRole("heading", { name: "Request details" })).toBeInTheDocument();
    expect(panel.getAllByText("req-activity-1")).toHaveLength(2);
    expect(panel.getByText("Summarize this request")).toBeInTheDocument();
    expect(panel.getByText("Here is the summary.")).toBeInTheDocument();
    expect(panel.getByText("authorization")).toBeInTheDocument();
    expect(panel.getAllByText("[REDACTED]")).toHaveLength(2);
    expect(panel.getByText(/"model": "smart"/)).toBeInTheDocument();
    expect(panel.getByText("2,399 tokens")).toBeInTheDocument();
    expect(panel.getByText("1.24 s")).toBeInTheDocument();
    expect(fake.callsTo("GET", "/logs/req-activity-1?includeContent=true")).toHaveLength(1);

    await user.click(panel.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("explains when sensitive content was not captured", async () => {
    const withoutContent = requestLog();
    delete withoutContent.content;
    fake = createFakeApi({ logs: [withoutContent] });
    fake.install();
    const user = userEvent.setup();
    await renderAt("/logs");

    await user.click(screen.getByText("iOS - Dev env"));

    expect(
      dialog().getAllByText(/Content was not captured for this request/).length,
    ).toBeGreaterThan(0);
  });

  it("shows rejected requests distinctly", async () => {
    fake = createFakeApi({
      logs: [requestLog({ id: "row-rejected", requestId: "req-rejected", status: 401 })],
    });
    fake.install();
    await renderAt("/logs");

    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });
});
