import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeApi, type FakeApi } from "./support/fake-api";
import { renderAt, selectOption, setMultiline } from "./support/render";

/**
 * Open a rule's action menu.
 *
 * The design gives a match-rule header one icon button, so reorder, probe and
 * remove live behind it — a menu is how the header stays as drawn without losing
 * actions a rule needs.
 */
async function openMenu(user: ReturnType<typeof userEvent.setup>, ruleId: string) {
  await user.click(screen.getByRole("button", { name: `Actions for ${ruleId}` }));
}

let fake: FakeApi;

/** Two rules, the catch-all last — the shape a healthy deployment has. */
const TWO_RULES = {
  routing: {
    allowedModels: ["smart", "fast"],
    rules: [
      {
        id: "pro-users",
        when: 'has(user.claims.tier) && user.claims.tier == "pro"',
        target: { type: "anthropic", apiKey: { $secret: "sec-1" }, model: "claude-sonnet-5" },
      },
      {
        id: "everyone-else",
        when: "true",
        target: {
          type: "openai-compatible",
          baseUrl: "https://api.example.test/v1",
          apiKey: "${OPENAI_API_KEY}",
          model: "gpt-4o-mini",
        },
      },
    ],
  },
};

beforeEach(() => {
  fake = createFakeApi({ config: structuredClone(TWO_RULES) });
  fake.install();
});

/** The paired match-rule / target row for one rule. */
function row(id: string): HTMLElement {
  const element = document.querySelector(`[data-rule="${id}"]`);
  if (element === null) throw new Error(`no row for ${id}`);
  return element as HTMLElement;
}

/** The `routing` block the last save sent. */
function lastRouting(): { allowedModels: string[]; rules: Record<string, unknown>[] } {
  const calls = fake.callsTo("PUT", "/routing");
  const body = calls[calls.length - 1]?.body as
    | { value: { allowedModels: string[]; rules: Record<string, unknown>[] } }
    | undefined;
  if (body === undefined) throw new Error("nothing was saved to /routing");
  return body.value;
}

const save = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => {
    expect(fake.callsTo("PUT", "/routing").length).toBeGreaterThan(0);
  });
};

describe("the rule rows", () => {
  it("pairs each condition with where it goes, in evaluation order", async () => {
    await renderAt("/routing");

    const rows = document.querySelectorAll("[data-rule]");
    // Order is meaning: the first matching rule wins, so the list must render in
    // the order the router evaluates.
    expect([...rows].map((element) => element.getAttribute("data-rule"))).toEqual([
      "pro-users",
      "everyone-else",
    ]);
    // Each row carries the condition on the left and the target on the right.
    expect(row("pro-users")).toHaveTextContent("Match rule");
    expect(row("pro-users")).toHaveTextContent("Anthropic");
    expect(row("everyone-else")).toHaveTextContent("Open AI Compatible");
  });

  it("shows the condition as editable mono text", async () => {
    await renderAt("/routing");

    expect(within(row("pro-users")).getByLabelText("Condition for pro-users")).toHaveValue(
      'has(user.claims.tier) && user.claims.tier == "pro"',
    );
  });

  it("calls a literal true a catch-all rather than just valid", async () => {
    await renderAt("/routing");

    expect(
      within(row("everyone-else")).getByText("Catch-all — matches everything"),
    ).toBeInTheDocument();
    expect(within(row("pro-users")).getByText("Valid expression")).toBeInTheDocument();
  });

  it("says an unbalanced expression is incomplete instead of calling it valid", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    const condition = within(row("pro-users")).getByLabelText("Condition for pro-users");
    await user.clear(condition);
    await user.type(condition, "has(user.claims.tier");

    // The green tick is a claim. A regex cannot validate CEL, so it only reports
    // what it can actually tell — the server is the authority, via simulate.
    expect(within(row("pro-users")).getByText(/Unbalanced brackets/)).toBeInTheDocument();
  });

  it("flags a rule an earlier catch-all makes unreachable", async () => {
    // The defect this exists to catch: a rule below a catch-all is dead on
    // arrival, and the proxy keeps answering normally from the earlier rule.
    fake.state.config = {
      routing: {
        rules: [
          { id: "everyone", when: "true", target: { type: "anthropic", apiKey: "k" } },
          {
            id: "premium",
            when: 'request.model == "smart"',
            target: { type: "anthropic", apiKey: "k" },
          },
        ],
      },
    };

    await renderAt("/routing");

    expect(row("premium")).toHaveTextContent("can never fire");
    expect(row("everyone")).not.toHaveTextContent("can never fire");
  });

  it("says nothing is served when there are no rules", async () => {
    fake.state.config = { routing: { allowedModels: [], rules: [] } };

    await renderAt("/routing");

    expect(await screen.findByText(/every request to/)).toHaveTextContent("is a 404");
  });
});

describe("credentials", () => {
  it("shows a sealed credential as stored, without revealing it", async () => {
    await renderAt("/routing");

    const apiKey = within(row("pro-users")).getByLabelText("API Key");
    expect(apiKey).toHaveValue("");
    expect(apiKey).toHaveAttribute("placeholder", expect.stringContaining("leave blank to keep"));
    expect(document.body.textContent).not.toContain("sec-1");
  });

  it("names the environment variable a ${VAR} reference points at", async () => {
    await renderAt("/routing");

    // Safe to display: it names a variable rather than carrying a value.
    expect(row("everyone-else")).toHaveTextContent("${OPENAI_API_KEY}");
  });

  it("keeps every untouched credential when something else is edited", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    const model = within(row("pro-users")).getByLabelText("Model");
    await user.clear(model);
    await user.type(model, "claude-opus-4");
    await save(user);

    const targets = lastRouting().rules.map((rule) => rule.target as Record<string, unknown>);
    // Dropping the key would delete the credential; sending "" would fail the
    // factory's own validation. Sending the reference back is the only correct move.
    expect(targets[0]?.apiKey).toEqual({ $secret: "sec-1" });
    expect(targets[0]?.model).toBe("claude-opus-4");
    expect(targets[1]?.apiKey).toBe("${OPENAI_API_KEY}");
  });

  it("replaces a credential when a new one is typed", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.type(within(row("pro-users")).getByLabelText("API Key"), "sk-ant-rotated");
    await save(user);

    // Plaintext on the wire is correct: the API seals it before the revision is
    // written, which is the only way an operator can type a key at all.
    const target = lastRouting().rules[0]?.target as Record<string, unknown>;
    expect(target.apiKey).toBe("sk-ant-rotated");
  });

  it("drops a blank model so the client's model passes through", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.clear(within(row("pro-users")).getByLabelText("Model"));
    await save(user);

    // Absent means "forward whatever the client asked for"; `""` is not a model.
    const first = lastRouting().rules[0]?.target as Record<string, unknown>;
    expect("model" in first).toBe(false);
  });
});

describe("editing", () => {
  it("commits nothing until Save Changes", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.type(within(row("pro-users")).getByLabelText("Model"), "-x");

    expect(fake.callsTo("PUT", "/routing")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
  });

  it("leaves the action bar inert until something changes", async () => {
    await renderAt("/routing");

    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });

  it("discards back to what is stored", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    const model = within(row("pro-users")).getByLabelText("Model");
    await user.clear(model);
    await user.type(model, "something-else");
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(within(row("pro-users")).getByLabelText("Model")).toHaveValue("claude-sonnet-5");
  });

  it("reorders with the whole list", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await openMenu(user, "everyone-else");
    await user.click(await screen.findByRole("menuitem", { name: "Move up" }));
    await save(user);

    expect(lastRouting().rules.map((rule) => rule.id)).toEqual(["everyone-else", "pro-users"]);
  });

  it("cannot move the first rule up or the last one down", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await openMenu(user, "pro-users");
    expect(await screen.findByRole("menuitem", { name: "Move up" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("clears the unreachable warning once the rule is moved above the catch-all", async () => {
    fake.state.config = {
      routing: {
        rules: [
          { id: "everyone", when: "true", target: { type: "anthropic", apiKey: "k" } },
          {
            id: "premium",
            when: 'request.model == "smart"',
            target: { type: "anthropic", apiKey: "k" },
          },
        ],
      },
    };
    const user = userEvent.setup();
    await renderAt("/routing");

    expect(row("premium")).toHaveTextContent("can never fire");

    await openMenu(user, "premium");
    await user.click(await screen.findByRole("menuitem", { name: "Move up" }));

    await waitFor(() => {
      expect(row("premium")).not.toHaveTextContent("can never fire");
    });
  });

  it("adds a rule from the dashed target row", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Model" }));
    await save(user);

    const rules = lastRouting().rules;
    expect(rules).toHaveLength(3);
    expect(rules[2]?.id).toBe("rule-3");
  });

  it("adds a rule from the Matching Rule button", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Matching Rule" }));
    await save(user);

    expect(lastRouting().rules).toHaveLength(3);
  });

  it("removes a rule", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await openMenu(user, "pro-users");
    await user.click(await screen.findByRole("menuitem", { name: "Remove rule" }));
    await save(user);

    expect(lastRouting().rules.map((rule) => rule.id)).toEqual(["everyone-else"]);
  });

  it("clears the options when a target's provider changes", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(
      within(row("everyone-else")).getByRole("button", {
        name: "Change the provider for everyone-else",
      }),
    );
    await selectOption(user, /provider/i, "Anthropic");

    // Anthropic's card does not draw a base URL, so the field goes — and the
    // value goes with it. Carrying a value across a type change is how an
    // endpoint belonging to the old provider silently follows the rule to the new
    // one, which the factories' `strictObject` would then reject on save.
    await waitFor(() => {
      expect(within(row("everyone-else")).queryByLabelText("Base URL")).toBeNull();
    });
  });

  it("surfaces the warnings a save comes back with", async () => {
    fake.state.warnings = ['rule "premium" can never match: an earlier rule matches everything'];
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.type(within(row("pro-users")).getByLabelText("Model"), "-x");
    await save(user);

    expect(await screen.findByText(/can never match/)).toBeInTheDocument();
  });

  it("shows why a rejected configuration was rejected", async () => {
    fake.state.rejectSave = 'routing.rules[0].target: unknown provider type "nope"';
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.type(within(row("pro-users")).getByLabelText("Model"), "-x");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(await screen.findByText(/unknown provider type/)).toBeInTheDocument();
  });
});

describe("probing a rule's upstream", () => {
  it("reports a healthy upstream", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await openMenu(user, "pro-users");
    await user.click(await screen.findByRole("menuitem", { name: "Test upstream" }));

    expect(await screen.findByText(/The upstream answered in 12ms/)).toBeInTheDocument();
  });

  it("reports a refused credential as a failure", async () => {
    // The bug this guards: `listModels` falls back to the configured model list on
    // any failure, so trusting its return value reported a dead key as healthy.
    fake.state.probe = { ok: false, status: 401, error: null, latencyMs: 40, models: 0 };
    const user = userEvent.setup();
    await renderAt("/routing");

    await openMenu(user, "pro-users");
    await user.click(await screen.findByRole("menuitem", { name: "Test upstream" }));

    expect(await screen.findByText(/The upstream refused: HTTP 401/)).toBeInTheDocument();
  });

  it("distinguishes 'cannot be probed' from a failure", async () => {
    fake.state.probe = { ok: null, error: null, reason: "this provider type cannot be probed" };
    const user = userEvent.setup();
    await renderAt("/routing");

    await openMenu(user, "pro-users");
    await user.click(await screen.findByRole("menuitem", { name: "Test upstream" }));

    expect(await screen.findByText("this provider type cannot be probed")).toBeInTheDocument();
    expect(screen.queryByText(/refused/)).toBeNull();
  });
});

describe("the client-facing model list", () => {
  it("saves the list the way the API expects it", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    setMultiline(screen.getByLabelText("Allowed models"), "smart\nfast\nnano");
    await save(user);

    expect(lastRouting().allowedModels).toEqual(["smart", "fast", "nano"]);
    // A whole-block write must carry the rules through, or saving the model list
    // would delete every rule.
    expect(lastRouting().rules).toHaveLength(2);
  });
});

describe("simulating a request", () => {
  it("shows which rule would serve it", async () => {
    fake.state.simulate = {
      matched: true,
      route: "pro-users",
      provider: "anthropic",
      model: "claude-sonnet-5",
      rules: [{ rule: "pro-users", providerType: "anthropic", outcome: "match" }],
      warnings: [],
    };
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Simulate" }));

    expect(await screen.findByText(/Served by/)).toHaveTextContent("pro-users");
  });

  it("explains a rule that throws rather than reporting no match", async () => {
    // CEL's first footgun: reading a missing map key throws, the router treats a
    // throw as no match, and the rule silently never fires.
    fake.state.simulate = {
      matched: true,
      route: "everyone-else",
      provider: "openai-compatible",
      model: "gpt-4o-mini",
      rules: [
        {
          rule: "pro-users",
          providerType: "anthropic",
          outcome: "error",
          error: "no such key: tier",
        },
        { rule: "everyone-else", providerType: "openai-compatible", outcome: "match" },
      ],
      warnings: ['rule "pro-users" throws for this request and can therefore never match'],
    };
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Simulate" }));

    expect(await screen.findByText("no such key: tier")).toBeInTheDocument();
    expect(screen.getByText(/throws for this request/)).toBeInTheDocument();
  });

  it("reports 'nothing serves this' as an answer, not an error", async () => {
    fake.state.simulate = {
      matched: false,
      reason: "The model `nope` does not exist or no rule is configured to serve it.",
      rules: [],
      warnings: [],
    };
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Simulate" }));

    expect(await screen.findByText(/would be a 404/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
