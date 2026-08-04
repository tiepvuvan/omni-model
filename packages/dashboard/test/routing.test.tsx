import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeApi, type FakeApi } from "./support/fake-api";
import { renderAt } from "./support/render";

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
  providers: {
    anthropic: { type: "anthropic", apiKey: { $secret: "sec-1" } },
    gateway: {
      type: "openai-compatible",
      baseUrl: "https://api.example.test/v1",
      apiKey: "${OPENAI_API_KEY}",
    },
    deepseek: { type: "deepseek", apiKey: "${DEEPSEEK_API_KEY}" },
  },
  routing: {
    allowedModels: ["smart", "fast"],
    rules: [
      {
        id: "pro-users",
        when: 'has(user.claims.tier) && user.claims.tier == "pro"',
        target: { provider: "anthropic", model: "claude-sonnet-5" },
      },
      {
        id: "everyone-else",
        when: "true",
        target: { provider: "gateway", model: "gpt-4o-mini" },
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
  const calls = fake.callsTo("PATCH", "/config");
  const body = calls[calls.length - 1]?.body as
    | {
        value: {
          routing: { allowedModels: string[]; rules: Record<string, unknown>[] };
        };
      }
    | undefined;
  if (body === undefined) throw new Error("nothing was saved to /config");
  return body.value.routing;
}

/** The centralized providers sent in the same atomic save as routing. */
function lastProviders(): Record<string, Record<string, unknown>> {
  const calls = fake.callsTo("PATCH", "/config");
  const body = calls[calls.length - 1]?.body as
    | { value: { providers: Record<string, Record<string, unknown>> } }
    | undefined;
  if (body === undefined) throw new Error("nothing was saved to /config");
  return body.value.providers;
}

const save = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => {
    expect(fake.callsTo("PATCH", "/config").length).toBeGreaterThan(0);
  });
};

const simulate = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Simulate a request" }));
  const dialog = await screen.findByRole("dialog", { name: "Simulate a request" });
  await user.click(within(dialog).getByRole("button", { name: "Simulate" }));
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
    // Spelled as the file's *menu* spells them: its card header says "Open AI",
    // its menu says "OpenAI", and the menu is the one that is right.
    expect(row("everyone-else")).toHaveTextContent("OpenAI compatible");
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

  it("starts a fresh deployment from complete model-routing rules", async () => {
    // An empty routing screen is a dead end: every request is a 404 and nothing
    // says what a working configuration looks like. The seeded policy is a
    // *draft*, so it shows a useful large-request/fallback split without storing
    // a configuration nobody asked for.
    fake.state.config = { routing: { allowedModels: [], rules: [] } };

    await renderAt("/routing");

    expect(within(row("large-context")).getByLabelText("Condition for large-context")).toHaveValue(
      "request.inputTokenCount > 16000",
    );
    expect(
      within(row("large-context")).getByRole("combobox", { name: "Provider" }),
    ).toHaveTextContent("openrouter · OpenAI compatible");
    expect(within(row("large-context")).getByLabelText("Model (optional)")).toHaveValue(
      "openai/gpt-4o",
    );
    expect(within(row("large-context")).queryByLabelText("API Key")).toBeNull();
    expect(within(row("large-context")).queryByLabelText("Base URL")).toBeNull();

    expect(within(row("default")).getByLabelText("Condition for default")).toHaveValue("true");
    expect(within(row("default")).getByLabelText("Model (optional)")).toHaveValue(
      "openai/gpt-4o-mini",
    );
    expect(row("default")).toHaveTextContent("Catch-all — matches everything");
    expect(fake.callsTo("PATCH", "/config")).toHaveLength(0);
    // Offering the policy as a draft means Save Changes is live, because the
    // screen now differs from what is stored.
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
  });
});

describe("centralized providers", () => {
  it("keeps credentials off routing rules and out of the routing screen", async () => {
    await renderAt("/routing");

    expect(within(row("pro-users")).queryByLabelText("API Key")).toBeNull();
    expect(within(row("everyone-else")).queryByLabelText("Base URL")).toBeNull();
    expect(document.body.textContent).not.toContain("sec-1");
    expect(document.body.textContent).not.toContain("${OPENAI_API_KEY}");
    expect(row("pro-users")).toHaveTextContent("anthropic · Anthropic");
    expect(row("everyone-else")).toHaveTextContent("gateway · OpenAI compatible");
  });

  it("saves provider references while preserving centralized credentials", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    const model = within(row("pro-users")).getByLabelText("Model (optional)");
    await user.clear(model);
    await user.type(model, "claude-opus-4");
    await save(user);

    const target = lastRouting().rules[0]?.target as Record<string, unknown>;
    expect(target).toEqual({ provider: "anthropic", model: "claude-opus-4" });
    expect(lastProviders().anthropic?.apiKey).toEqual({ $secret: "sec-1" });
    expect(lastProviders().gateway?.apiKey).toBe("${OPENAI_API_KEY}");
  });

  it("drops a blank model so the client's model passes through", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.clear(within(row("pro-users")).getByLabelText("Model (optional)"));
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

    await user.type(within(row("pro-users")).getByLabelText("Model (optional)"), "-x");

    expect(fake.callsTo("PATCH", "/config")).toHaveLength(0);
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

    const model = within(row("pro-users")).getByLabelText("Model (optional)");
    await user.clear(model);
    await user.type(model, "something-else");
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(within(row("pro-users")).getByLabelText("Model (optional)")).toHaveValue(
      "claude-sonnet-5",
    );
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

  it("does not render a competing Add model action", async () => {
    await renderAt("/routing");

    expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
    expect(screen.getByRole("button", { name: "Matching Rule" })).toBeInTheDocument();
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

  it("changes a rule by named provider id without copying provider options", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(row("everyone-else")).getByRole("combobox", { name: "Provider" }));
    await user.click(await screen.findByRole("option", { name: "anthropic · Anthropic" }));
    await save(user);

    const target = lastRouting().rules[1]?.target as Record<string, unknown>;
    expect(target.provider).toBe("anthropic");
    expect(target).not.toHaveProperty("apiKey");
    expect(target).not.toHaveProperty("baseUrl");
  });

  it("stores an optional fallback provider on the rule", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(
      within(row("everyone-else")).getByRole("combobox", { name: "Fallback provider" }),
    );
    await user.click(await screen.findByRole("option", { name: "deepseek" }));
    await save(user);

    expect(lastRouting().rules[1]?.target).toMatchObject({
      provider: "gateway",
      fallbackProvider: "deepseek",
      model: "gpt-4o-mini",
    });
  });

  it("surfaces the warnings a save comes back with", async () => {
    fake.state.warnings = ['rule "premium" can never match: an earlier rule matches everything'];
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.type(within(row("pro-users")).getByLabelText("Model (optional)"), "-x");
    await save(user);

    expect(await screen.findByText(/can never match/)).toBeInTheDocument();
  });

  it("shows why a rejected configuration was rejected", async () => {
    fake.state.rejectSave = 'routing.rules[0].target: unknown provider type "nope"';
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.type(within(row("pro-users")).getByLabelText("Model (optional)"), "-x");
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

describe("simulating a request", () => {
  it("opens from the header immediately before Save Changes", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    const trigger = screen.getByRole("button", { name: "Simulate a request" });
    const saveButton = screen.getByRole("button", { name: "Save Changes" });
    expect(trigger.compareDocumentPosition(saveButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    expect(screen.queryByRole("dialog", { name: "Simulate a request" })).toBeNull();

    await user.click(trigger);

    expect(await screen.findByRole("dialog", { name: "Simulate a request" })).toBeInTheDocument();
  });

  it("submits the requested CEL context inputs", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Simulate a request" }));
    const dialog = await screen.findByRole("dialog", { name: "Simulate a request" });
    await user.type(within(dialog).getByLabelText("Input token count"), "12000");
    await user.type(
      within(dialog).getByLabelText("User providers"),
      "firebase-auth, firebase-app-check",
    );
    await user.type(within(dialog).getByLabelText("Client name"), "ios-production");
    await user.type(within(dialog).getByLabelText("IP address"), "203.0.113.10");
    await user.click(within(dialog).getByRole("button", { name: "Simulate" }));

    await waitFor(() => {
      expect(fake.callsTo("POST", "/routing/simulate")).toHaveLength(1);
    });
    expect(fake.callsTo("POST", "/routing/simulate")[0]?.body).toMatchObject({
      model: "smart",
      inputTokenCount: 12000,
      providers: ["firebase-auth", "firebase-app-check"],
      clientName: "ios-production",
      ip: "203.0.113.10",
      method: "POST",
      path: "/v1/chat/completions",
    });
  });

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

    await simulate(user);

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

    await simulate(user);

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

    await simulate(user);

    expect(await screen.findByText(/would be a 404/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the model dropdown", () => {
  it("loads the list from the upstream and says the key was accepted", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    // The list only appears once a credential exists to check — which is the
    // point: populating it *is* the key check.
    await user.click(within(row("pro-users")).getByLabelText("Model (optional)"));

    expect(await within(row("pro-users")).findByText(/Key accepted/)).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "gpt-4o-mini" })).toBeInTheDocument();
  });

  it("reports a refused key rather than showing an empty list", async () => {
    // A wrong key must not look like "this provider has no models".
    fake.state.upstreamModels = { ok: false, models: [], status: 401, error: null };
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(row("pro-users")).getByLabelText("Model (optional)"));

    expect(await within(row("pro-users")).findByText(/refused this key/)).toBeInTheDocument();
  });

  it("still accepts a model the upstream does not advertise", async () => {
    // An endpoint can serve a model it does not list, so the field stays free
    // text — but it says so rather than silently accepting a typo.
    const user = userEvent.setup();
    await renderAt("/routing");

    const field = within(row("pro-users")).getByLabelText("Model (optional)");
    await user.clear(field);
    await user.type(field, "some-private-model");

    expect(await within(row("pro-users")).findByText(/is not in the list/)).toBeInTheDocument();
    await save(user);
    const target = lastRouting().rules[0]?.target as Record<string, unknown>;
    expect(target.model).toBe("some-private-model");
  });

  it("says so when a provider cannot list models at all", async () => {
    fake.state.upstreamModels = {
      ok: null,
      models: [],
      reason: "this provider answers from configuration without contacting the upstream",
    };
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(row("pro-users")).getByLabelText("Model (optional)"));

    expect(
      await within(row("pro-users")).findByText(/without contacting the upstream/),
    ).toBeInTheDocument();
  });
});

describe("the provider selectors", () => {
  it("offers every configured provider by stable id", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(row("pro-users")).getByRole("combobox", { name: "Provider" }));

    const items = (await screen.findAllByRole("option")).map((item) => item.textContent);
    expect(items).toEqual([
      "anthropic · Anthropic",
      "gateway · OpenAI compatible",
      "deepseek · DeepSeek",
    ]);
  });

  it("names the current provider id and type without opening", async () => {
    await renderAt("/routing");

    expect(within(row("pro-users")).getByRole("combobox", { name: "Provider" })).toHaveTextContent(
      "anthropic · Anthropic",
    );
  });
});

describe("the variable reference", () => {
  it("names every namespace without being opened", async () => {
    // Autocomplete only helps someone who knows a namespace exists — you have to
    // type `user.` to discover what `user` has. The summary answers the first
    // question, which is what can be matched on at all.
    await renderAt("/routing");

    const summary = within(row("pro-users")).getByText(/A CEL expression over/);
    for (const namespace of ["request", "user", "client", "http"]) {
      expect(summary).toHaveTextContent(namespace);
    }
    expect(summary).not.toHaveTextContent("device");
    expect(summary).not.toHaveTextContent("now");
    expect(summary).toHaveTextContent("Only a literal true counts as a match");
  });

  it("lists every field with a worked example when opened", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(row("pro-users")).getByRole("button", { name: "Show variables" }));

    const reference = within(row("pro-users"));
    expect(reference.getByText("request.inputTokenCount")).toBeInTheDocument();
    expect(reference.getByText("user.providers")).toBeInTheDocument();
    expect(reference.getByText("client.id")).toBeInTheDocument();
    // An example, not just a name: a field list you cannot copy from is a glossary.
    expect(reference.getByText("request.inputTokenCount > 4")).toBeInTheDocument();
    expect(reference.getByText('"firebase-auth" in user.providers')).toBeInTheDocument();
    // `startsWith` appears twice on purpose — as the `model` example and in the
    // function list — so it is asserted as a pair rather than as a single node.
    expect(reference.getAllByText('request.model.startsWith("claude-")')).toHaveLength(2);
  });

  it("shows a dynamic map's example already guarded", async () => {
    // The example for a claim has to be the *correct* form, because the obvious
    // form throws and the router turns a throw into "no match".
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(within(row("pro-users")).getByRole("button", { name: "Show variables" }));

    expect(
      within(row("pro-users")).getByText('has(user.claims.tier) && user.claims.tier == "value"'),
    ).toBeInTheDocument();
    expect(within(row("pro-users")).getByText(/silently never fires/)).toBeInTheDocument();
  });
});

describe("adding a rule", () => {
  it("adds a rule with a configured provider selected", async () => {
    const user = userEvent.setup();
    await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Matching Rule" }));

    expect(within(row("rule-3")).getByRole("combobox", { name: "Provider" })).toHaveTextContent(
      "anthropic · Anthropic",
    );
  });
});
