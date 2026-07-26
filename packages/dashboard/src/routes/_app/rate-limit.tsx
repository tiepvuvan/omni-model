import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import connectorImage from "../../assets/connector.svg";
import deleteIcon from "../../assets/delete.svg";
import plusIcon from "../../assets/plus.svg";
import { ActionBar, WidePane } from "../../components/chrome";
import { BudgetCard } from "../../components/ratelimit/budget-card";
import { CelEditor } from "../../components/routing/cel-editor";
import { CelReference } from "../../components/routing/cel-reference";
import { Button, Callout, Card, IconButton } from "../../components/ui/primitives";
import { api, type ConfigResponse, type RateLimitRule } from "../../lib/api";

export const Route = createFileRoute("/_app/rate-limit")({
  loader: async (): Promise<{ config: ConfigResponse }> => ({ config: await api.config() }),
  component: RateLimitScreen,
});

/**
 * What the proxy enforces when the stored document has no `rateLimits` block.
 *
 * A copy of core's schema default, on purpose: the dashboard does not depend on
 * `@omni-model/core` at runtime, and an absent block is *not* "no limits" — the
 * schema fills it in and the proxy enforces it. Showing an empty screen would
 * report freedom that does not exist. `rate-limit-defaults.test.ts` compares this
 * against the real schema, so the two cannot drift.
 */
export const SCHEMA_DEFAULTS: readonly RateLimitRule[] = [
  { name: "per-user-requests", key: "user", requests: { limit: 30, window: "1h" } },
  { name: "per-user-daily-tokens", key: "user", tokens: { limit: 30_000, window: "1d" } },
];

function rulesOf(config: ConfigResponse): RateLimitRule[] {
  const stored = config.config?.rateLimits;
  return Array.isArray(stored) ? stored : SCHEMA_DEFAULTS.map((rule) => ({ ...rule }));
}

/** How a rule is identified on screen and in the counter keyspace. */
const idOf = (rule: RateLimitRule, index: number): string =>
  rule.id ?? rule.name ?? `rateLimits[${index}]`;

/** A rule with no condition applies to every request — the design's Default row. */
const isDefault = (rule: RateLimitRule): boolean => rule.when === undefined;

function RateLimitScreen() {
  const { config } = Route.useLoaderData();
  const router = useRouter();
  const stored = rulesOf(config);

  const [draft, setDraft] = useState<RateLimitRule[]>(stored);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);

  /*
   * The server is the only thing that compiles CEL, so it is the only authority on
   * whether a condition is valid. `POST /config/validate` builds the candidate and
   * throws it away — free of consequence, and its message is the one a save would
   * produce. Debounced; the editor's lexical checks cover the gap.
   */
  useEffect(() => {
    if (!dirty) {
      setCompileError(null);
      return;
    }
    const timer = setTimeout(() => {
      void api
        .validate({ ...(config.config ?? {}), rateLimits: draft })
        .then((result) => setCompileError(result.valid ? null : (result.error ?? null)))
        .catch(() => setCompileError(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, dirty, config.config]);

  /**
   * The compile error for one rule, when it is about that rule's condition.
   *
   * Validation reports one error for the whole document; a message about
   * `rateLimits[2]` shown under every rule would be worse than showing it nowhere,
   * and a message about a *window* does not belong under the expression box.
   */
  const compileErrorFor = (ruleId: string): string | null => {
    if (compileError === null) return null;
    const index = draft.findIndex((rule, at) => idOf(rule, at) === ruleId);
    if (index === -1) return null;
    const mentioned =
      compileError.includes(`rateLimits[${index}]`) || compileError.includes(`"${ruleId}"`);
    if (!mentioned || !compileError.includes("when")) return null;
    return compileError.replace(/^.*?when:\s*/, "");
  };

  const updateRule = (index: number, next: RateLimitRule) => {
    setDraft((now) => now.map((rule, at) => (at === index ? next : rule)));
  };

  const removeRule = (index: number) => {
    setDraft((now) => now.filter((_, at) => at !== index));
  };

  const addRule = () => {
    const taken = new Set(draft.map((rule, index) => idOf(rule, index)));
    let n = draft.length + 1;
    while (taken.has(`limit-${n}`)) n += 1;
    setDraft((now) => {
      const rule: RateLimitRule = {
        id: `limit-${n}`,
        when: "",
        key: "user",
        tokens: { limit: 30_000, window: "1d" },
      };
      // Ahead of the unconditional rules, so the screen keeps the design's shape:
      // conditions first, baselines last. Order is only ever presentation here —
      // every matching rule is enforced — but it is the order a 429 reports in.
      const first = now.findIndex(isDefault);
      if (first === -1) return [...now, rule];
      return [...now.slice(0, first), rule, ...now.slice(first)];
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.putRateLimits(draft, "update rate limits");
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ActionBar dirty={dirty} busy={busy} onDiscard={() => setDraft(stored)} onSave={save} />

      <WidePane>
        {error !== null ? (
          <Callout tone="danger" title="The change was rejected" role="alert">
            <p className="mt-[4px]">{error}</p>
          </Callout>
        ) : null}

        {draft.length === 0 ? (
          <Callout tone="warning" role="status">
            No rules, so nothing is capped: one client can spend the whole upstream bill. Add a rule
            to put a budget back.
          </Callout>
        ) : null}

        {draft.map((rule, index) => {
          const id = idOf(rule, index);
          const fallback = isDefault(rule);

          return (
            <div key={id} className="flex w-full items-start" data-rule={id}>
              {/*
               * The condition. A rule with none is the design's "Default" card:
               * a header and nothing else, because there is no expression to edit.
               */}
              {fallback ? (
                <Card className="min-w-0 flex-1" title="Default" />
              ) : (
                <Card
                  className="min-w-0 flex-1"
                  title="Match rule"
                  actions={
                    <IconButton
                      icon={deleteIcon}
                      label={`Remove ${id}`}
                      onClick={() => removeRule(index)}
                    />
                  }
                  bodyClassName="gap-[12px]"
                >
                  <CelEditor
                    id={`when-${id}`}
                    ruleLabel={id}
                    value={rule.when ?? ""}
                    onChange={(when) => updateRule(index, { ...rule, when })}
                    serverError={compileErrorFor(id)}
                  />
                  <CelReference />
                </Card>
              )}

              <img src={connectorImage} alt="" aria-hidden className="h-[50px] w-[72px] shrink-0" />

              <BudgetCard
                rule={rule}
                label={id}
                idPrefix={`limit-${id}`}
                onChange={(next) => updateRule(index, next)}
                {...(fallback ? {} : { onRemove: () => removeRule(index) })}
              />
            </div>
          );
        })}

        <Button icon={plusIcon} onClick={addRule} className="self-start">
          Rate Limit Rule
        </Button>

        {/*
         * How the rules combine. It is the one thing about this screen that is not
         * visible in it: rules are not alternatives, so a request that matches two
         * of them is held to both, and the first budget to run out is the one that
         * answers 429.
         */}
        <p className="type-label-12 max-w-[720px] text-foreground-secondary">
          Every rule whose condition matches is enforced — they are budgets, not alternatives — and
          a rule with no condition applies to every request. When more than one applies, the first
          to run out is the one that rejects.
        </p>
      </WidePane>
    </>
  );
}
