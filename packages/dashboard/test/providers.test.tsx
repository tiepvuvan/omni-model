import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeApi, type FakeApi } from "./support/fake-api";
import { renderAt } from "./support/render";

let fake: FakeApi;

beforeEach(() => {
  fake = createFakeApi();
  fake.install();
});

/** The provider card titled by its stable configuration id. */
function card(id: string): HTMLElement {
  const section = screen
    .getAllByText(id, { exact: true })
    .map((element) => element.closest("section"))
    .find((element): element is HTMLElement => element !== null);
  if (section === undefined) throw new Error(`no provider card for ${id}`);
  return section;
}

/** The centralized provider map the last save sent. */
function lastProviders(): Record<string, Record<string, unknown>> {
  const calls = fake.callsTo("PUT", "/providers");
  const body = calls[calls.length - 1]?.body as
    | { value: Record<string, Record<string, unknown>> }
    | undefined;
  if (body === undefined) throw new Error("nothing was saved to /providers");
  return body.value;
}

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(fake.callsTo("PUT", "/providers")).toHaveLength(1));
}

describe("Providers", () => {
  it("starts an empty deployment with a useful OpenRouter draft", async () => {
    await renderAt("/providers");

    expect(card("openrouter")).toHaveTextContent("OpenAI compatible");
    expect(within(card("openrouter")).getByLabelText("Base URL")).toHaveValue(
      "https://openrouter.ai/api/v1",
    );
    expect(card("openrouter")).toHaveTextContent("${OPENROUTER_API_KEY}");
    expect(fake.callsTo("PUT", "/providers")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
  });

  it("adds and saves several providers in one centralized map", async () => {
    const user = userEvent.setup();
    await renderAt("/providers");

    await user.click(screen.getByRole("button", { name: "Provider" }));
    expect(card("provider-2")).toBeInTheDocument();
    await user.type(
      within(card("provider-2")).getByLabelText("Base URL"),
      "https://second.example.test/v1",
    );
    await save(user);

    expect(Object.keys(lastProviders())).toEqual(["openrouter", "provider-2"]);
    expect(lastProviders()["provider-2"]).toMatchObject({
      type: "openai-compatible",
      baseUrl: "https://second.example.test/v1",
    });
  });

  it("preserves an untouched sealed credential while editing other options", async () => {
    fake.state.config = {
      providers: {
        anthropic: {
          type: "anthropic",
          apiKey: { $secret: "sec-anthropic" },
          baseUrl: "https://api.anthropic.com",
        },
      },
      routing: { rules: [] },
    };
    const user = userEvent.setup();
    await renderAt("/providers");

    const key = within(card("anthropic")).getByLabelText("API Key");
    expect(key).toHaveValue("");
    expect(key).toHaveAttribute("placeholder", expect.stringContaining("leave blank to keep"));
    expect(document.body.textContent).not.toContain("sec-anthropic");
    await user.type(
      within(card("anthropic")).getByLabelText("Max Tokens Default (optional)"),
      "4096",
    );
    await save(user);

    expect(lastProviders().anthropic).toMatchObject({
      type: "anthropic",
      apiKey: { $secret: "sec-anthropic" },
      maxTokensDefault: 4096,
    });
  });

  it("tests the unsaved candidate configuration without persisting it", async () => {
    fake.state.config = {
      providers: {
        primary: {
          type: "openai-compatible",
          baseUrl: "https://api.example.test/v1",
          apiKey: { $secret: "sec-old" },
        },
      },
    };
    const user = userEvent.setup();
    await renderAt("/providers");

    await user.type(within(card("primary")).getByLabelText("API Key (optional)"), "sk-new");
    await user.click(within(card("primary")).getByRole("button", { name: "Test configuration" }));

    await waitFor(() => expect(fake.callsTo("POST", "/providers/models")).toHaveLength(1));
    expect(fake.callsTo("POST", "/providers/models")[0]?.body).toMatchObject({
      provider: {
        type: "openai-compatible",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-new",
      },
    });
    expect(fake.callsTo("PUT", "/providers")).toHaveLength(0);
    expect(await within(card("primary")).findByText("Provider verified")).toBeInTheDocument();
  });
});
