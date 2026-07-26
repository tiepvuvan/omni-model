import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeApi, type FakeApi } from "./support/fake-api";
import { dialog, renderAt, selectOption, setMultiline } from "./support/render";

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

/** The `<li>` for one rule, found by the id or name shown in its header. */
function ruleRow(label: string): HTMLElement {
  const heading = screen.getByText(label);
  const row = heading.closest("li");
  if (row === null) throw new Error(`no rule row for ${label}`);
  return row;
}

describe("the rule list", () => {
  it("shows rules in evaluation order with their target", async () => {
    await renderAt("/routing");

    const rows = await screen.findAllByRole("listitem");
    // Order is meaning: the first matching rule wins, so the list must render in
    // the order the router evaluates rather than sorted or grouped.
    expect(rows[0]).toHaveTextContent("pro-users");
    expect(rows[0]).toHaveTextContent("anthropic");
    expect(rows[0]).toHaveTextContent("claude-sonnet-5");
    expect(rows[1]).toHaveTextContent("everyone-else");
    expect(rows[1]).toHaveTextContent("openai-compatible");
  });

  it("marks the catch-all", async () => {
    await renderAt("/routing");

    expect(within(ruleRow("everyone-else")).getByText("catch-all")).toBeInTheDocument();
    expect(within(ruleRow("pro-users")).queryByText("catch-all")).toBeNull();
  });

  it("says a credential is sealed without ever showing one", async () => {
    await renderAt("/routing");

    expect(within(ruleRow("pro-users")).getByText("sealed credential")).toBeInTheDocument();
    // A `${VAR}` reference is safe to display: it names an environment variable
    // rather than carrying a value.
    expect(within(ruleRow("everyone-else")).getByText("${OPENAI_API_KEY}")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("sec-1");
  });

  it("says nothing is served when there are no rules", async () => {
    fake.state.config = { routing: { allowedModels: [], rules: [] } };

    await renderAt("/routing");

    expect(await screen.findByText(/every request to/)).toHaveTextContent("is a 404");
  });

  it("flags a rule an earlier catch-all makes unreachable", async () => {
    // The defect this exists to catch: appending to a list that already ends in a
    // catch-all puts the new rule where it can never fire, and the proxy keeps
    // answering normally from the earlier rule.
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

    const row = ruleRow("premium");
    expect(within(row).getByText("unreachable")).toBeInTheDocument();
    expect(row).toHaveTextContent("can never fire");
    expect(within(ruleRow("everyone")).queryByText("unreachable")).toBeNull();
  });
});

describe("reordering", () => {
  it("moves a rule up by rewriting the whole list", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Move everyone-else up" }));

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/routing")).toHaveLength(1);
    });
    // A per-rule write deliberately keeps a rule's position, so a whole-list PUT
    // is the only request that can express a new order.
    const body = fake.callsTo("PUT", "/routing")[0]?.body as {
      value: { rules: { id: string }[] };
    };
    expect(body.value.rules.map((rule) => rule.id)).toEqual(["everyone-else", "pro-users"]);

    const rows = await screen.findAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("everyone-else");
  });

  it("cannot move the first rule up or the last one down", async () => {
    await renderAt("/routing");

    expect(screen.getByRole("button", { name: "Move pro-users up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move everyone-else down" })).toBeDisabled();
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

    expect(within(ruleRow("premium")).getByText("unreachable")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Move premium up" }));

    await waitFor(() => {
      expect(within(ruleRow("premium")).queryByText("unreachable")).toBeNull();
    });
  });
});

describe("adding a rule", () => {
  it("sends the id, condition and target together", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    await user.type(dialog().getByLabelText("Rule id"), "cheap-tier");
    await user.type(dialog().getByLabelText("Condition"), "!has(user.claims.tier)");
    await user.type(dialog().getByLabelText("Model"), "llama-3.3-70b");
    // The form opens on `openai-compatible` — the preferred default, not whatever
    // sorts first — so its schema is what drives the fields here.
    await user.type(dialog().getByLabelText("Base url"), "https://api.groq.com/openai/v1");
    await user.type(dialog().getByLabelText("Api key"), "sk-typed-in-the-form");
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/routing/rules/cheap-tier")).toHaveLength(1);
    });
    const body = fake.callsTo("PUT", "/routing/rules/cheap-tier")[0]?.body as {
      value: { when: string; target: Record<string, unknown> };
    };
    expect(body.value.when).toBe("!has(user.claims.tier)");
    expect(body.value.target).toMatchObject({
      type: "openai-compatible",
      model: "llama-3.3-70b",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "sk-typed-in-the-form",
    });
  });

  it("opens on the preferred provider rather than the first alphabetically", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Add rule" }));

    // The fake registry lists `anthropic` first, matching how `GET /meta` sorts.
    expect(dialog().getByRole("combobox", { name: /provider/i })).toHaveTextContent(
      "openai-compatible",
    );
  });

  it("refuses an id that another rule already uses", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    await user.type(dialog().getByLabelText("Rule id"), "pro-users");
    await user.type(dialog().getByLabelText("Condition"), "true");
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    expect(await screen.findByText("Another rule already uses this id.")).toBeInTheDocument();
    expect(fake.callsTo("PUT", "/routing/rules/pro-users")).toHaveLength(0);
  });

  it("requires a condition, naming the catch-all as the way to match everything", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    await user.type(dialog().getByLabelText("Rule id"), "no-condition");
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    expect(
      await screen.findByText("A condition is required — use true for a catch-all."),
    ).toBeInTheDocument();
  });

  it("warns while typing that a catch-all shadows everything after it", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    await user.type(dialog().getByLabelText("Condition"), "true");

    expect(await screen.findByText(/Keep this rule last/)).toBeInTheDocument();
  });

  it("surfaces the warnings a save comes back with", async () => {
    // The server is the authority on this: it computes the same shadowing check
    // against what it actually stored.
    fake.state.warnings = [
      'rule "premium" can never match: "everyone-else" earlier in the list matches everything',
    ];
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    await user.type(dialog().getByLabelText("Rule id"), "premium");
    await user.type(dialog().getByLabelText("Condition"), 'request.model == "smart"');
    await user.type(dialog().getByLabelText("Api key"), "sk-ant-x");
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    expect(await screen.findByText(/can never match/)).toBeInTheDocument();
    expect(screen.getByText("Saved, but read this")).toBeInTheDocument();
  });

  it("shows why a rejected configuration was rejected", async () => {
    fake.state.rejectSave = 'routing.rules[2].target: unknown provider type "nope"';
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    await user.type(dialog().getByLabelText("Rule id"), "broken");
    await user.type(dialog().getByLabelText("Condition"), "true");
    await user.type(dialog().getByLabelText("Api key"), "sk-ant-x");
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    expect(await screen.findByText(/unknown provider type/)).toBeInTheDocument();
  });
});

describe("editing a rule", () => {
  it("keeps a sealed credential when the field is left blank", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(ruleRow("pro-users")).getByRole("button", { name: "Edit" }));

    const apiKey = dialog().getByLabelText("Api key");
    // There is no endpoint that returns plaintext — `reveal` is unreachable from
    // the admin API — so the box is empty and the placeholder carries the meaning.
    expect(apiKey).toHaveValue("");
    expect(apiKey).toHaveAttribute("placeholder", expect.stringContaining("leave blank to keep"));

    await user.clear(dialog().getByLabelText("Model"));
    await user.type(dialog().getByLabelText("Model"), "claude-opus-4");
    await user.click(screen.getByRole("button", { name: "Save rule" }));

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/routing/rules/pro-users")).toHaveLength(1);
    });
    const body = fake.callsTo("PUT", "/routing/rules/pro-users")[0]?.body as {
      value: { target: Record<string, unknown> };
    };
    // Dropping the key would delete the credential; sending "" would fail the
    // factory's own validation. Sending the reference back is the only correct move.
    expect(body.value.target.apiKey).toEqual({ $secret: "sec-1" });
    expect(body.value.target.model).toBe("claude-opus-4");
  });

  it("keeps an environment reference when the field is left blank", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(ruleRow("everyone-else")).getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save rule" }));

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/routing/rules/everyone-else")).toHaveLength(1);
    });
    const body = fake.callsTo("PUT", "/routing/rules/everyone-else")[0]?.body as {
      value: { target: Record<string, unknown> };
    };
    expect(body.value.target.apiKey).toBe("${OPENAI_API_KEY}");
  });

  it("replaces the credential when a new one is typed", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(ruleRow("pro-users")).getByRole("button", { name: "Edit" }));
    await user.type(dialog().getByLabelText("Api key"), "sk-ant-rotated");
    await user.click(screen.getByRole("button", { name: "Save rule" }));

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/routing/rules/pro-users")).toHaveLength(1);
    });
    const body = fake.callsTo("PUT", "/routing/rules/pro-users")[0]?.body as {
      value: { target: Record<string, unknown> };
    };
    // Plaintext on the wire is correct here: the API seals it before the revision
    // is written, which is the only way an operator can type a key at all.
    expect(body.value.target.apiKey).toBe("sk-ant-rotated");
  });

  it("does not let the id change, because logs already reference it", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(ruleRow("pro-users")).getByRole("button", { name: "Edit" }));

    expect(dialog().getByLabelText("Rule id")).toBeDisabled();
  });

  it("drops a blank model so the client's model passes through", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(ruleRow("pro-users")).getByRole("button", { name: "Edit" }));
    await user.clear(dialog().getByLabelText("Model"));
    await user.click(screen.getByRole("button", { name: "Save rule" }));

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/routing/rules/pro-users")).toHaveLength(1);
    });
    const body = fake.callsTo("PUT", "/routing/rules/pro-users")[0]?.body as {
      value: { target: Record<string, unknown> };
    };
    // Absent means "forward whatever the client asked for"; `""` is not a model.
    expect("model" in body.value.target).toBe(false);
  });

  it("clears options when the provider type changes", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(ruleRow("everyone-else")).getByRole("button", { name: "Edit" }));
    expect(dialog().getByLabelText("Base url")).toHaveValue("https://api.example.test/v1");

    await selectOption(user, /provider/i, "anthropic");

    // The value is cleared, not the field: both provider types happen to accept a
    // `baseUrl`, but carrying one *value* across a type change is how a key or an
    // endpoint belonging to the old provider silently follows the rule to the new
    // one. The factories validate with `strictObject`, so an option the new type
    // does not accept would be rejected on save.
    await waitFor(() => {
      expect(dialog().getByLabelText("Base url")).toHaveValue("");
    });
    expect(dialog().queryByLabelText("Include stream usage")).toBeNull();
  });
});

describe("removing a rule", () => {
  it("deletes by id", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(ruleRow("pro-users")).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(fake.callsTo("DELETE", "/routing/rules/pro-users")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByText("pro-users")).toBeNull();
    });
  });
});

describe("probing a rule's upstream", () => {
  it("reports a healthy upstream", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(ruleRow("pro-users")).getByRole("button", { name: "Test upstream" }));

    expect(await screen.findByText(/The upstream answered in 12ms/)).toBeInTheDocument();
  });

  it("reports a refused credential as a failure", async () => {
    // The bug this guards: `listModels` falls back to the configured model list on
    // any failure, so trusting its return value reported a dead key as healthy.
    fake.state.probe = { ok: false, status: 401, error: null, latencyMs: 40, models: 0 };
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(ruleRow("pro-users")).getByRole("button", { name: "Test upstream" }));

    expect(await screen.findByText(/The upstream refused: HTTP 401/)).toBeInTheDocument();
  });

  it("distinguishes 'cannot be probed' from a failure", async () => {
    fake.state.probe = { ok: null, error: null, reason: "this provider type cannot be probed" };
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(ruleRow("pro-users")).getByRole("button", { name: "Test upstream" }));

    const result = await screen.findByText("this provider type cannot be probed");
    expect(result).toBeInTheDocument();
    expect(screen.queryByText(/refused/)).toBeNull();
  });
});

describe("the client-facing model list", () => {
  it("saves the list the way the API expects it", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    setMultiline(screen.getByLabelText("Allowed models"), "smart\nfast\nnano");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/routing")).toHaveLength(1);
    });
    const body = fake.callsTo("PUT", "/routing")[0]?.body as {
      value: { allowedModels: string[]; rules: unknown[] };
    };
    expect(body.value.allowedModels).toEqual(["smart", "fast", "nano"]);
    // A whole-block write must carry the rules through, or saving the model list
    // would delete every rule.
    expect(body.value.rules).toHaveLength(2);
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
    expect(screen.getByText("match")).toBeInTheDocument();
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

    // No modal here, so scope to the panel that owns the simulate form.
    const panel = within(screen.getByLabelText("Token claims").closest("section") as HTMLElement);
    const model = panel.getByLabelText("Model");
    await user.clear(model);
    await user.type(model, "nope");
    await user.click(screen.getByRole("button", { name: "Simulate" }));

    expect(await screen.findByText(/would be a 404/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses claims that are not a JSON object", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    const claims = screen.getByLabelText("Token claims");
    await user.clear(claims);
    await user.type(claims, "not json");
    await user.click(screen.getByRole("button", { name: "Simulate" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Claims must be a JSON object");
    expect(fake.callsTo("POST", "/routing/simulate")).toHaveLength(0);
  });
});
