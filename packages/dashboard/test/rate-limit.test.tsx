import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { RateLimitRule } from "../src/lib/api";
import { createFakeApi, type FakeApi } from "./support/fake-api";
import { renderAt } from "./support/render";

let fake: FakeApi;

/**
 * A tiered configuration: two conditional budgets and one baseline.
 *
 * The shape the design draws — `Match rule` rows above a `Default` row — and the
 * shape that exercises the semantics worth getting wrong: the baseline is not a
 * fallback, it applies alongside the rules above it.
 */
const TIERED = {
  rateLimits: [
    {
      id: "free-tier",
      when: 'has(user.claims.tier) && user.claims.tier == "free"',
      tokens: { limit: 30_000, window: "30d" },
    },
    {
      id: "pro-tier",
      when: 'has(user.claims.tier) && user.claims.tier == "pro"',
      tokens: { limit: 50_000, window: "14d" },
    },
    { id: "baseline", tokens: { limit: 50_000, window: "30d" } },
  ],
};

beforeEach(() => {
  fake = createFakeApi({ config: structuredClone(TIERED) });
  fake.install();
});

/**
 * Open a select inside one row and choose an option.
 *
 * Row-scoped because every row has its own `Window` — the screen-wide helper finds
 * all of them. The popup itself is portalled, so the option comes from
 * the document rather than the row, and `findByRole` because it mounts a frame
 * before it is styled open.
 */
async function pick(
  user: ReturnType<typeof userEvent.setup>,
  scope: HTMLElement,
  trigger: RegExp,
  option: string,
) {
  await user.click(within(scope).getByRole("combobox", { name: trigger }));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** Every rule row's id, in the order the screen renders them. */
function ruleIds(): (string | null)[] {
  return [...document.querySelectorAll("[data-rule]")].map((el) => el.getAttribute("data-rule"));
}

/** The design gives a rule two delete buttons, one per card. Either will do. */
function removeButton(scope: HTMLElement, id: string): HTMLElement {
  const [first] = within(scope).getAllByRole("button", { name: `Remove ${id}` });
  if (first === undefined) throw new Error(`no remove button for ${id}`);
  return first;
}

/** The paired condition / budget row for one rule. */
function row(id: string): HTMLElement {
  const element = document.querySelector(`[data-rule="${id}"]`);
  if (element === null) throw new Error(`no row for ${id}`);
  return element as HTMLElement;
}

/** The `rateLimits` list the last save sent. */
function lastSaved(): RateLimitRule[] {
  const calls = fake.callsTo("PUT", "/rate-limits");
  const body = calls[calls.length - 1]?.body as { value: RateLimitRule[] } | undefined;
  if (body === undefined) throw new Error("nothing was saved to /rate-limits");
  return body.value;
}

const save = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => {
    expect(fake.callsTo("PUT", "/rate-limits").length).toBeGreaterThan(0);
  });
};

describe("the rule rows", () => {
  it("pairs each condition with its budget, in order", async () => {
    await renderAt("/rate-limit");

    expect(ruleIds()).toEqual(["free-tier", "pro-tier", "baseline"]);
    expect(row("free-tier")).toHaveTextContent("Match rule");
    // Grouped as the design draws it — `30,000`, not `30000`.
    expect(within(row("free-tier")).getByLabelText("Number of tokens")).toHaveValue("30,000");
    expect(within(row("free-tier")).getByLabelText("Window")).toHaveTextContent(
      "1 month (30 days)",
    );
  });

  it("renders a rule with no condition as the Default row", async () => {
    await renderAt("/rate-limit");

    const baseline = row("baseline");
    expect(baseline).toHaveTextContent("Default");
    // No expression box: there is no condition to edit, and an empty editor would
    // read as one that had been cleared.
    expect(within(baseline).queryByLabelText(/^Condition for/)).toBeNull();
    // Nor a delete: the design draws the Default row without one.
    expect(within(baseline).queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("explains that rules stack rather than falling through", async () => {
    await renderAt("/rate-limit");

    // The one thing the screen cannot show: a request matching two rules is held
    // to both. Without this an operator reads the list as first-match-wins.
    expect(screen.getByText(/budgets, not\s+alternatives/)).toBeInTheDocument();
  });
});

describe("editing a budget", () => {
  it("saves the number the operator typed, ungrouped", async () => {
    const user = userEvent.setup();
    await renderAt("/rate-limit");

    const field = within(row("free-tier")).getByLabelText("Number of tokens");
    await user.clear(field);
    await user.type(field, "45000");
    await save(user);

    expect(lastSaved()[0]?.tokens).toEqual({ limit: 45_000, window: "30d" });
  });

  it("accepts a pasted value that carries its separators", async () => {
    const user = userEvent.setup();
    await renderAt("/rate-limit");

    const field = within(row("pro-tier")).getByLabelText("Number of tokens");
    await user.clear(field);
    await user.paste("120,000");
    await save(user);

    expect(lastSaved()[1]?.tokens?.limit).toBe(120_000);
  });

  it("refuses an emptied field instead of keeping the old number", async () => {
    const user = userEvent.setup();
    await renderAt("/rate-limit");

    await user.clear(within(row("free-tier")).getByLabelText("Number of tokens"));

    // Showing an empty box while still holding 30,000 would be a lie about what a
    // save would store; the server rejects a non-positive limit too.
    expect(within(row("free-tier")).getByText("Enter a number greater than zero.")).toBeVisible();
  });

  it("changes the window through the select", async () => {
    const user = userEvent.setup();
    await renderAt("/rate-limit");

    await pick(user, row("free-tier"), /Window/, "1 day");
    await save(user);

    expect(lastSaved()[0]?.tokens?.window).toBe("1d");
  });

  it("keeps a window the select does not offer", async () => {
    fake = createFakeApi({
      config: { rateLimits: [{ id: "odd", tokens: { limit: 5000, window: "45m" } }] },
    });
    fake.install();
    const user = userEvent.setup();
    await renderAt("/rate-limit");

    // Opening a screen must not rewrite a value nobody touched, so an unlisted
    // duration is offered alongside the presets rather than replaced by one.
    expect(screen.getByLabelText("Window")).toHaveTextContent("45m");
    await user.clear(screen.getByLabelText("Number of tokens"));
    await user.type(screen.getByLabelText("Number of tokens"), "6000");
    await save(user);

    expect(lastSaved()[0]?.tokens).toEqual({ limit: 6000, window: "45m" });
  });
});

describe("what the screen can express", () => {
  it("draws only the two fields the model has", async () => {
    await renderAt("/rate-limit");

    // One axis, one owner: tokens, per user. There is nothing else to configure,
    // so there is nothing else on the card — no counter key, no request window.
    const card = row("free-tier");
    expect(within(card).getByLabelText("Number of tokens")).toBeInTheDocument();
    expect(within(card).getByLabelText("Window")).toBeInTheDocument();
    expect(within(card).queryByLabelText("Counted per")).toBeNull();
    expect(within(card).queryByLabelText("Number of requests")).toBeNull();
  });
});

describe("adding and removing rules", () => {
  it("adds a conditional rule above the baselines", async () => {
    const user = userEvent.setup();
    await renderAt("/rate-limit");

    await user.click(screen.getByRole("button", { name: "Rate Limit Rule" }));

    // The design's shape: conditions first, the Default row last.
    expect(ruleIds()).toEqual(["free-tier", "pro-tier", "limit-4", "baseline"]);
  });

  it("gives a new rule an id, since the counter keyspace is keyed by it", async () => {
    const user = userEvent.setup();
    await renderAt("/rate-limit");

    await user.click(screen.getByRole("button", { name: "Rate Limit Rule" }));
    const field = within(row("limit-4")).getByLabelText("Number of tokens");
    await user.clear(field);
    await user.type(field, "1000");
    // The condition is required; an empty one is not a rule that matches nothing,
    // it is a document the server refuses to compile.
    await user.type(within(row("limit-4")).getByLabelText("Condition for limit-4"), "true");
    await save(user);

    expect(lastSaved()[2]).toMatchObject({ id: "limit-4", when: "true", tokens: { limit: 1000 } });
  });

  it("removes a rule from either card", async () => {
    const user = userEvent.setup();
    await renderAt("/rate-limit");

    // Two buttons, one per card, exactly as the design draws them.
    expect(
      within(row("pro-tier")).getAllByRole("button", { name: "Remove pro-tier" }),
    ).toHaveLength(2);

    await user.click(removeButton(row("pro-tier"), "pro-tier"));
    await save(user);

    expect(lastSaved().map((rule) => rule.id)).toEqual(["free-tier", "baseline"]);
  });

  it("warns when there are no rules, because that is uncapped spend", async () => {
    // An explicitly empty list, which is the one thing an absent block does not
    // mean — reachable by deleting every rule, or by importing a config with none.
    fake = createFakeApi({ config: { rateLimits: [] } });
    fake.install();
    await renderAt("/rate-limit");

    expect(screen.getByText(/one client can spend the whole upstream bill/)).toBeVisible();
    expect(document.querySelectorAll("[data-rule]")).toHaveLength(0);
  });
});

describe("an unconfigured deployment", () => {
  it("shows the limits the proxy is actually enforcing, not an empty screen", async () => {
    fake = createFakeApi({ config: {} });
    fake.install();
    await renderAt("/rate-limit");

    // An absent `rateLimits` block is not "no limits": the schema fills it in and
    // the proxy enforces it. An empty screen would report freedom that is not real.
    expect(ruleIds()).toEqual(["per-user-daily-tokens"]);
    expect(screen.getByLabelText("Number of tokens")).toHaveValue("30,000");
    // Nothing has changed yet, so there is nothing to save.
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });
});

describe("validation", () => {
  it("shows a rejected save at the top of the screen", async () => {
    fake.state.rejectSave = "rateLimits[0]: tokens.window: invalid duration";
    const user = userEvent.setup();
    await renderAt("/rate-limit");

    const field = within(row("free-tier")).getByLabelText("Number of tokens");
    await user.clear(field);
    await user.type(field, "10");
    await save(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("invalid duration");
  });

  it("answers an empty condition in operator language, not the parser's", async () => {
    // Asked to compile nothing, CEL says `Unexpected token: EOF` — true, and no
    // help at all to someone who has not typed anything yet.
    fake.state.validateError =
      'rate limit rule "limit-4": invalid `when` expression: invalid CEL expression "": Unexpected token: EOF';
    const user = userEvent.setup();
    await renderAt("/rate-limit");

    await user.click(screen.getByRole("button", { name: "Rate Limit Rule" }));

    await waitFor(() => {
      expect(within(row("limit-4")).getByText(/A condition is required/)).toBeVisible();
    });
    expect(within(row("limit-4")).queryByText(/Unexpected token/)).toBeNull();
  });

  it("attributes a condition error to the rule it names", async () => {
    fake.state.validateError =
      'rate limit rule "free-tier": invalid `when` expression: no such key';
    const user = userEvent.setup();
    await renderAt("/rate-limit");

    await user.type(within(row("free-tier")).getByLabelText("Condition for free-tier"), " ");

    // The server is the only thing that compiles CEL, so its message is the real
    // verdict — but it is one message about one rule, and it belongs on that rule.
    await waitFor(() => {
      expect(within(row("free-tier")).getByText(/no such key/)).toBeVisible();
    });
    expect(within(row("pro-tier")).queryByText(/no such key/)).toBeNull();
  });
});
