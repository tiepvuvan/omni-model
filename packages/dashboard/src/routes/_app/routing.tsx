import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import deleteIcon from "../../assets/delete.svg";
import plusIcon from "../../assets/plus.svg";
import scienceIcon from "../../assets/science.svg";
import { ActionBar, WidePane } from "../../components/chrome";
import { CelEditor } from "../../components/routing/cel-editor";
import { CelReference } from "../../components/routing/cel-reference";
import { ModelField } from "../../components/routing/model-field";
import { VENDOR_TITLES, VendorIcon } from "../../components/routing/provider-picker";
import { RuleMenu } from "../../components/routing/rule-menu";
import { SimulatePanel } from "../../components/routing/simulate-panel";
import { Button, Callout, Card, IconButton, SelectField } from "../../components/ui/primitives";
import {
  api,
  type ConfigResponse,
  type MetaResponse,
  type ProbeResponse,
  type ProvidersBlock,
  type RoutingBlock,
  type RoutingRule,
} from "../../lib/api";
import { pageHead } from "../../lib/page-title";
import { DEFAULT_PROVIDER_ID, starterProviders } from "../../lib/provider-config";

export const Route = createFileRoute("/_app/routing")({
  head: () => pageHead("Model Routing"),
  loader: async (): Promise<{ config: ConfigResponse; meta: MetaResponse }> => {
    const [config, meta] = await Promise.all([api.config(), api.meta()]);
    return { config, meta };
  },
  component: RoutingScreen,
});

/** `when: "true"` — the only expression the router treats as a catch-all. */
const CATCH_ALL = "true";
const NO_FALLBACK = "__no_fallback__";

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

function modelFor(type: string, tier: "capable" | "fast"): string {
  const models: Record<string, Record<"capable" | "fast", string>> = {
    "openai-compatible": {
      capable: "openai/gpt-4o",
      fast: "openai/gpt-4o-mini",
    },
    openai: { capable: "gpt-4o", fast: "gpt-4o-mini" },
    anthropic: { capable: "claude-sonnet-4-5", fast: "claude-haiku-4-5" },
    google: { capable: "gemini-2.5-pro", fast: "gemini-2.5-flash" },
    deepseek: { capable: "deepseek-reasoner", fast: "deepseek-chat" },
  };
  return models[type]?.[tier] ?? "your-model";
}

/**
 * A complete, editable policy for a deployment with no routing configuration.
 *
 * Large requests go to a more capable model and everything else takes the
 * cheaper path. Credentials are environment references rather than empty
 * fields, and the draft is never stored until the operator chooses Save.
 */
function starterRules(providerId: string, providerType: string): RoutingRule[] {
  return [
    {
      id: "large-context",
      name: "Large context",
      when: "request.inputTokenCount > 16000",
      target: { provider: providerId, model: modelFor(providerType, "capable") },
    },
    {
      id: "default",
      name: "Default",
      when: "true",
      target: { provider: providerId, model: modelFor(providerType, "fast") },
    },
  ];
}

function uniqueProviderId(preferred: string, providers: ProvidersBlock): string {
  const base = preferred.replace(/[^A-Za-z0-9_-]/g, "-") || "provider";
  if (!(base in providers)) return base;
  let number = 2;
  while (`${base}-${number}` in providers) number += 1;
  return `${base}-${number}`;
}

/**
 * Turn legacy inline route targets into named providers in the initial draft.
 *
 * Nothing is stored until Save Changes, so an old revision keeps booting while
 * the operator can review the exact migration the new screen proposes.
 */
function prepareDraft(config: ConfigResponse): {
  providers: ProvidersBlock;
  routing: RoutingBlock;
} {
  const providers: ProvidersBlock = { ...(config.config?.providers ?? {}) };
  const stored = routingOf(config);
  const rules = stored.rules.map((rule, index) => {
    if (rule.target.provider !== undefined) return rule;
    const type = rule.target.type;
    if (type === undefined) return rule;
    const id = uniqueProviderId(rule.id ?? type ?? `provider-${index + 1}`, providers);
    const { type: _type, model, ...options } = rule.target;
    providers[id] = { type, ...options };
    return {
      ...rule,
      target: {
        provider: id,
        ...(model === undefined ? {} : { model }),
      },
    };
  });

  if (rules.length > 0) return { providers, routing: { ...stored, rules } };
  if (Object.keys(providers).length === 0) Object.assign(providers, starterProviders());
  const firstId = Object.keys(providers)[0] ?? DEFAULT_PROVIDER_ID;
  const firstType = providers[firstId]?.type ?? "openai-compatible";
  return { providers, routing: { ...stored, rules: starterRules(firstId, firstType) } };
}

function RoutingScreen() {
  const { config } = Route.useLoaderData();
  const router = useRouter();
  const stored = routingOf(config);
  const storedProviders = config.config?.providers ?? {};
  const prepared = prepareDraft(config);

  const [draft, setDraft] = useState<RoutingBlock>(prepared.routing);
  const [draftProviders, setDraftProviders] = useState<ProvidersBlock>(prepared.providers);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [probes, setProbes] = useState<Record<string, ProbeResponse | "running">>({});

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(stored) ||
    JSON.stringify(draftProviders) !== JSON.stringify(storedProviders);
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
        .validate({ ...(config.config ?? {}), providers: draftProviders, routing: draft })
        .then((result) => setCompileError(result.valid ? null : (result.error ?? null)))
        // A failed validate call is not a validation failure; leaving the previous
        // verdict up would be a lie either way, so it clears.
        .catch(() => setCompileError(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, draftProviders, dirty, config.config]);

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

  const providerIds = Object.keys(draftProviders);
  const firstProviderId = providerIds[0] ?? "";

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
        rules: [...now.rules, { id: `rule-${n}`, when: "", target: { provider: firstProviderId } }],
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
      const rules = draft.rules.map((rule) => ({
        ...rule,
        target: {
          ...rule.target,
          ...(rule.target.model === "" ? { model: undefined } : {}),
        },
      }));
      const result = await api.patchConfig(
        { providers: draftProviders, routing: { ...draft, rules } },
        "update model routing",
      );
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
          setDraftProviders(storedProviders);
          setWarnings([]);
        }}
        onSave={save}
        actions={
          <Button icon={scienceIcon} onClick={() => setSimulateOpen(true)}>
            Simulate a request
          </Button>
        }
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

        {providerIds.length === 0 ? (
          <Callout tone="warning" title="Configure a provider first" role="status">
            Routing rules can only select named providers.{" "}
            <Link to="/providers" className="underline">
              Open Providers
            </Link>
            .
          </Callout>
        ) : null}

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
          const providerId = rule.target.provider ?? "";
          const provider = draftProviders[providerId];
          const providerType = provider?.type ?? rule.target.type ?? "";

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
              <span aria-hidden className="mt-[24px] h-[2px] w-[72px] shrink-0 bg-border" />

              {/* The target: named provider references and the model only. */}
              <Card
                className="w-[408px] shrink-0 self-stretch"
                title="Provider & model"
                icon={<VendorIcon type={providerType} size={24} />}
                actions={
                  <IconButton
                    icon={deleteIcon}
                    label={`Remove ${id}`}
                    onClick={() => removeRule(index)}
                  />
                }
              >
                {rule.target.provider === undefined ? (
                  <Callout tone="warning" role="status">
                    This stored rule uses a legacy inline provider. Choose a named provider to
                    migrate it; its credential remains sealed while you do.
                  </Callout>
                ) : null}

                <SelectField
                  label="Provider"
                  value={providerId}
                  items={providerIds.map((providerKey) => ({
                    value: providerKey,
                    label: `${providerKey} · ${
                      VENDOR_TITLES[draftProviders[providerKey]?.type ?? ""] ??
                      draftProviders[providerKey]?.type ??
                      "Unknown"
                    }`,
                  }))}
                  onValueChange={(provider) =>
                    setTarget(index, {
                      provider,
                      ...(rule.target.fallbackProvider === undefined
                        ? {}
                        : { fallbackProvider: rule.target.fallbackProvider }),
                      ...(rule.target.model === undefined ? {} : { model: rule.target.model }),
                    })
                  }
                  help="Credentials and endpoint settings live on the Providers page."
                />

                <SelectField
                  label="Fallback provider"
                  value={rule.target.fallbackProvider ?? NO_FALLBACK}
                  items={[
                    { value: NO_FALLBACK, label: "No fallback" },
                    ...providerIds
                      .filter((providerKey) => providerKey !== providerId)
                      .map((providerKey) => ({ value: providerKey, label: providerKey })),
                  ]}
                  onValueChange={(fallbackProvider) =>
                    setTarget(index, {
                      ...rule.target,
                      ...(fallbackProvider === NO_FALLBACK
                        ? { fallbackProvider: undefined }
                        : { fallbackProvider }),
                    })
                  }
                  help="Tried only when the primary provider returns an upstream error."
                />

                <ModelField
                  provider={provider}
                  value={rule.target.model ?? ""}
                  onChange={(model) => setTarget(index, { ...rule.target, model })}
                />
              </Card>
            </div>
          );
        })}

        <Button
          icon={plusIcon}
          onClick={addRule}
          className="self-start"
          disabled={providerIds.length === 0}
        >
          Matching Rule
        </Button>
      </WidePane>

      <SimulatePanel
        open={simulateOpen}
        onOpenChange={setSimulateOpen}
        suggestedModel={draft.allowedModels[0] ?? draft.rules[0]?.target.model ?? null}
      />
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
