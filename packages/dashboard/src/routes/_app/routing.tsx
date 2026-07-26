import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import connectorImage from "../../assets/connector.svg";
import deleteIcon from "../../assets/delete.svg";
import plusIcon from "../../assets/plus.svg";
import plusTargetIcon from "../../assets/plus-target.svg";
import { ActionBar, WidePane } from "../../components/chrome";
import { CelEditor } from "../../components/routing/cel-editor";
import { CelReference } from "../../components/routing/cel-reference";
import { ModelField } from "../../components/routing/model-field";
import { ProviderPicker, VendorIcon } from "../../components/routing/provider-picker";
import { RuleMenu } from "../../components/routing/rule-menu";
import { SimulatePanel } from "../../components/routing/simulate-panel";
import { mergeCredentials, SchemaForm } from "../../components/schema-form";
import { Button, Callout, Card, IconButton } from "../../components/ui/primitives";
import {
  api,
  type ConfigResponse,
  type MetaResponse,
  type ProbeResponse,
  type RoutingBlock,
  type RoutingRule,
} from "../../lib/api";
import { PREFERRED_PROVIDERS, preferredType } from "../../lib/preferred";

export const Route = createFileRoute("/_app/routing")({
  loader: async (): Promise<{ config: ConfigResponse; meta: MetaResponse }> => {
    const [config, meta] = await Promise.all([api.config(), api.meta()]);
    return { config, meta };
  },
  component: RoutingScreen,
});

/** `when: "true"` — the only expression the router treats as a catch-all. */
const CATCH_ALL = "true";

/**
 * The target fields the design draws, per provider type.
 *
 * A curated list: the factories accept more than the file shows, and rendering all
 * of it turns a two-field card into a form. `SchemaForm` appends anything
 * *required* the list misses, so a save can never need a hidden field. `model` is
 * absent because the card renders it itself, last, as a dropdown.
 */
const TARGET_FIELDS: Record<string, readonly string[]> = {
  openai: ["apiKey"],
  "openai-compatible": ["baseUrl", "apiKey"],
  anthropic: ["apiKey"],
  google: ["apiKey"],
};

function routingOf(config: ConfigResponse): RoutingBlock {
  const routing = config.config?.routing;
  return { allowedModels: routing?.allowedModels ?? [], rules: routing?.rules ?? [] };
}

const idOf = (rule: RoutingRule, index: number): string => rule.id ?? `rules[${index}]`;

/**
 * Rules an earlier catch-all makes unreachable.
 *
 * The same rule as the server's `unreachableRules`, computed again here so a dead
 * rule is marked *before* a save rather than only reported after. Only a literal
 * `true` counts: a condition that happens to be true for every real request is
 * not statically detectable, and guessing would flag rules that are working.
 */
function catchAllIndex(rules: readonly RoutingRule[]): number {
  return rules.findIndex((rule) => rule.when.trim() === CATCH_ALL);
}

/**
 * The rule a deployment with none starts from.
 *
 * An empty routing screen is a dead end: every request is a 404, and nothing on
 * the page says what the shape of a working configuration is. Seeding one
 * catch-all rule makes the answer visible — a condition of `true`, a provider, a
 * key — and it is a *draft*, so nothing is stored until Save Changes. Which also
 * means it cannot quietly create a configuration nobody asked for.
 */
function defaultRule(providerType: string): RoutingRule {
  return { id: "everyone", name: "Everyone", when: "true", target: { type: providerType } };
}

function RoutingScreen() {
  const { config, meta } = Route.useLoaderData();
  const router = useRouter();
  const stored = routingOf(config);
  // Not `meta.providers[0]`: `/meta` sorts alphabetically, which would seed every
  // new deployment with Anthropic purely because of the letter A.
  const firstProvider = preferredType(meta.providers, PREFERRED_PROVIDERS);

  const [draft, setDraft] = useState<RoutingBlock>(() =>
    stored.rules.length === 0 ? { ...stored, rules: [defaultRule(firstProvider)] } : stored,
  );
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [probes, setProbes] = useState<Record<string, ProbeResponse | "running">>({});

  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  const catchAll = catchAllIndex(draft.rules);

  /*
   * The server is the only thing that actually compiles CEL.
   *
   * `POST /config/validate` builds the candidate document and throws it away, so
   * asking it is free of consequence and its message is exactly the one a save
   * would produce. Debounced, because it runs on every keystroke; the editor's own
   * lexical checks cover the gap in between.
   *
   * The error names a path (`routing.rules[2] when: …`), which is how it gets
   * attributed back to the rule that caused it rather than shown screen-wide.
   */
  const [compileError, setCompileError] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) {
      setCompileError(null);
      return;
    }
    const timer = setTimeout(() => {
      void api
        .validate({ ...(config.config ?? {}), routing: draft })
        .then((result) => setCompileError(result.valid ? null : (result.error ?? null)))
        // A failed validate call is not a validation failure; leaving the previous
        // verdict up would be a lie either way, so it clears.
        .catch(() => setCompileError(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, dirty, config.config]);

  /**
   * The compile error for one rule, if it is about that rule.
   *
   * Validation reports one error for the whole document, and showing a message
   * about `rules[2]` under every rule would be worse than showing it nowhere.
   */
  const compileErrorFor = (ruleId: string): string | null => {
    if (compileError === null) return null;
    const index = draft.rules.findIndex((rule, at) => idOf(rule, at) === ruleId);
    if (index === -1) return null;
    const mentioned =
      compileError.includes(`rules[${index}]`) || compileError.includes(`"${ruleId}"`);
    if (!mentioned) return null;
    /*
     * Only a `when:` problem belongs here.
     *
     * `validate` reports the first thing wrong with the whole document, which is
     * often an unfilled provider option — and putting "expected string at apiKey"
     * under the *expression* points at the wrong control. The API Key field shows
     * its own state, and the save path reports the rest at the top of the screen.
     * A seeded default rule would otherwise open with a red expression box before
     * the operator has typed anything.
     */
    if (!compileError.includes("when")) return null;
    return compileError.replace(/^.*?when:\s*/, "");
  };

  const updateRule = (index: number, patch: Partial<RoutingRule>) => {
    setDraft((now) => ({
      ...now,
      rules: now.rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)),
    }));
  };

  const setTarget = (index: number, target: RoutingRule["target"]) => {
    updateRule(index, { target });
  };

  const addRule = () => {
    // A new rule needs an id that is stable and unique, since logs reference it.
    const taken = new Set(draft.rules.map((rule, index) => idOf(rule, index)));
    let n = draft.rules.length + 1;
    while (taken.has(`rule-${n}`)) n += 1;
    setDraft((now) => {
      // The provider is chosen from the new card's own header, one click away — so
      // a new rule needs no separate "pick a provider" step.
      return {
        ...now,
        rules: [...now.rules, { id: `rule-${n}`, when: "", target: { type: firstProvider } }],
      };
    });
  };

  const removeRule = (index: number) => {
    setDraft((now) => ({ ...now, rules: now.rules.filter((_, at) => at !== index) }));
  };

  const move = (index: number, delta: number) => {
    setDraft((now) => {
      const rules = [...now.rules];
      const moved = rules[index];
      const displaced = rules[index + delta];
      if (moved === undefined || displaced === undefined) return now;
      rules[index] = displaced;
      rules[index + delta] = moved;
      return { ...now, rules };
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const rules = draft.rules.map((rule, index) => {
        const previous: Partial<RoutingRule["target"]> = stored.rules[index]?.target ?? {};
        const { type, model, ...options } = rule.target;
        const { type: _t, model: _m, ...storedOptions } = previous;
        return {
          ...rule,
          target: {
            type,
            ...mergeCredentials(options, storedOptions),
            ...(model === undefined || model === "" ? {} : { model }),
          },
        };
      });
      const result = await api.putRouting({ ...draft, rules }, "update model routing");
      setWarnings(result.warnings ?? []);
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const probe = async (id: string) => {
    setProbes((now) => ({ ...now, [id]: "running" }));
    try {
      const result = await api.testRule(id);
      setProbes((now) => ({ ...now, [id]: result }));
    } catch (caught) {
      setProbes((now) => ({
        ...now,
        [id]: { ok: false, error: caught instanceof Error ? caught.message : "probe failed" },
      }));
    }
  };

  return (
    <>
      <ActionBar
        dirty={dirty}
        busy={busy}
        onDiscard={() => {
          setDraft(stored);
          setWarnings([]);
        }}
        onSave={save}
      />

      <WidePane>
        {error !== null ? (
          <Callout tone="danger" title="The change was rejected" role="alert">
            <p className="mt-[4px]">{error}</p>
          </Callout>
        ) : null}

        {warnings.map((warning) => (
          <Callout key={warning} tone="warning" title="Saved, but read this" role="status">
            <p className="mt-[4px]">{warning}</p>
          </Callout>
        ))}

        {draft.rules.length === 0 ? (
          <Callout tone="warning" role="status">
            No rules, so every request to <span className="type-mono-12">/v1</span> is a 404. Add
            one with <span className="type-mono-12">true</span> as its condition to serve everything
            through a single upstream.
          </Callout>
        ) : null}

        {draft.rules.map((rule, index) => {
          const id = idOf(rule, index);
          const unreachable = catchAll !== -1 && index > catchAll;
          const probeResult = probes[id];
          const schema =
            meta.providers.find((entry) => entry.type === rule.target.type)?.optionsSchema ?? null;

          return (
            <div key={id} className="flex w-full items-start" data-rule={id}>
              {/* The match rule: a card whose body is the expression box. */}
              <Card
                className="min-w-0 flex-1"
                title="Match rule"
                actions={
                  <RuleMenu
                    ruleId={id}
                    canMoveUp={index > 0}
                    canMoveDown={index < draft.rules.length - 1}
                    probing={probeResult === "running"}
                    onMoveUp={() => move(index, -1)}
                    onMoveDown={() => move(index, 1)}
                    onTest={() => void probe(id)}
                    onRemove={() => removeRule(index)}
                  />
                }
                bodyClassName="gap-[12px]"
              >
                <CelEditor
                  id={`when-${id}`}
                  ruleLabel={id}
                  value={rule.when}
                  onChange={(when) => updateRule(index, { when })}
                  serverError={compileErrorFor(id)}
                />

                <CelReference />

                {unreachable ? (
                  <p className="type-label-12 text-destructive">
                    A catch-all above this rule matches everything, so this rule can never fire.
                    Move it above rule {catchAll + 1}.
                  </p>
                ) : null}

                {probeResult !== undefined && probeResult !== "running" ? (
                  <ProbeResult result={probeResult} />
                ) : null}
              </Card>

              {/* The connector between the rule and where it goes. */}
              <img src={connectorImage} alt="" aria-hidden className="h-[50px] w-[72px] shrink-0" />

              {/* The target: provider, credentials and model together. */}
              <Card
                className="w-[408px] shrink-0 self-stretch"
                title={
                  <ProviderPicker
                    available={meta.providers.map((entry) => entry.type)}
                    value={rule.target.type}
                    onChange={(type) => {
                      // Options belong to a provider type; carrying them across a
                      // change would submit keys the new factory rejects.
                      if (type !== rule.target.type) setTarget(index, { type });
                    }}
                  />
                }
                icon={<VendorIcon type={rule.target.type} size={24} />}
                actions={
                  <IconButton
                    icon={deleteIcon}
                    label={`Remove ${id}`}
                    onClick={() => removeRule(index)}
                  />
                }
              >
                <SchemaForm
                  schema={schema}
                  values={rule.target}
                  only={TARGET_FIELDS[rule.target.type] ?? ["apiKey"]}
                  omit={["type", "model"]}
                  componentType={rule.target.type}
                  idPrefix={`target-${id}`}
                  onChange={(options) =>
                    setTarget(index, {
                      ...options,
                      type: rule.target.type,
                    } as RoutingRule["target"])
                  }
                />

                <ModelField
                  target={rule.target}
                  value={rule.target.model ?? ""}
                  onChange={(model) => setTarget(index, { ...rule.target, model })}
                />
              </Card>
            </div>
          );
        })}

        {/* The dashed add-target row the design ends the list with. */}
        <div className="flex w-full items-start">
          <div className="min-w-0 flex-1" />
          <div className="h-[50px] w-[72px] shrink-0" />
          <button
            type="button"
            onClick={addRule}
            className="flex h-[54px] w-[408px] shrink-0 items-center justify-center gap-[6px] rounded-[var(--radius-card)] border border-dashed border-border bg-background-l3 type-copy-14 text-foreground-secondary hover:bg-item-selection"
          >
            <img src={plusTargetIcon} alt="" aria-hidden className="size-[16px]" />
            Model
          </button>
        </div>

        <Button icon={plusIcon} onClick={addRule} className="self-start">
          Matching Rule
        </Button>

        <SimulatePanel
          suggestedModel={draft.allowedModels[0] ?? draft.rules[0]?.target.model ?? null}
        />
      </WidePane>
    </>
  );
}

function ProbeResult({ result }: { result: ProbeResponse }) {
  if (result.ok === null) {
    return (
      <Callout tone="info" role="status">
        {result.reason ?? "This provider type cannot be probed."}
      </Callout>
    );
  }
  return (
    <Callout tone={result.ok ? "success" : "danger"} role="status">
      {result.ok
        ? `The upstream answered${result.latencyMs === undefined ? "" : ` in ${result.latencyMs}ms`}${
            result.models === undefined ? "" : `, listing ${result.models} models`
          }.`
        : `The upstream refused: ${result.error ?? `HTTP ${result.status ?? "error"}`}.`}
    </Callout>
  );
}
