import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { CATCH_ALL, RuleEditor } from "../../components/routing/rule-editor";
import { SimulatePanel } from "../../components/routing/simulate-panel";
import { isEnvRef, isSecretRef } from "../../components/schema-form";
import { PageBody, PageHeader } from "../../components/shell";
import { Badge, Button, Callout, Panel, TextAreaField } from "../../components/ui/primitives";
import {
  api,
  type ConfigResponse,
  type MetaResponse,
  type ProbeResponse,
  type RoutingBlock,
  type RoutingRule,
} from "../../lib/api";

export const Route = createFileRoute("/_app/routing")({
  loader: async (): Promise<{ config: ConfigResponse; meta: MetaResponse }> => {
    const [config, meta] = await Promise.all([api.config(), api.meta()]);
    return { config, meta };
  },
  component: RoutingScreen,
});

/** The stored routing block, defaulted for a deployment that has none yet. */
function routingOf(config: ConfigResponse): RoutingBlock {
  const routing = config.config?.routing;
  return {
    allowedModels: routing?.allowedModels ?? [],
    rules: routing?.rules ?? [],
  };
}

const idOf = (rule: RoutingRule, index: number): string => rule.id ?? `rules[${index}]`;

/**
 * Rules an earlier catch-all makes unreachable.
 *
 * The same rule as the server's `unreachableRules`, computed again here so the
 * list can mark a dead rule *before* a save rather than only reporting it after.
 * Only a literal `true` counts: a condition that happens to be true for every
 * real request is not statically detectable, and guessing would flag rules that
 * are working.
 */
function shadowedFrom(rules: readonly RoutingRule[]): number {
  return rules.findIndex((rule) => rule.when.trim() === CATCH_ALL);
}

function RoutingScreen() {
  const { config, meta } = Route.useLoaderData();
  const router = useRouter();

  const routing = routingOf(config);
  const [editing, setEditing] = useState<{ rule: RoutingRule; index: number } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeResponse | "running">>({});

  /**
   * Every mutation funnels through here.
   *
   * A save is the server's chance to say the configuration is valid but
   * self-defeating, so the returned warnings are surfaced rather than dropped —
   * a rule appended after a catch-all is the case that matters, because nothing
   * about a request would ever reveal it.
   */
  const mutate = async (
    label: string,
    action: () => Promise<{ warnings?: string[] }>,
    // The rule editor stays open on failure so the rule can be fixed, and shows
    // the reason itself. Reporting it here too would print the same sentence
    // twice on one screen.
    options: { surfaceError?: boolean } = {},
  ) => {
    setBusy(label);
    setError(null);
    try {
      const result = await action();
      setWarnings(result.warnings ?? []);
      await router.invalidate();
    } catch (caught) {
      if (options.surfaceError !== false) {
        setError(caught instanceof Error ? caught.message : "The change could not be saved.");
      }
      throw caught;
    } finally {
      setBusy(null);
    }
  };

  const catchAllAt = shadowedFrom(routing.rules);

  const move = (index: number, delta: number) => {
    const next = [...routing.rules];
    const target = index + delta;
    const moved = next[index];
    const displaced = next[target];
    if (moved === undefined || displaced === undefined) return;
    next[index] = displaced;
    next[target] = moved;
    // Reordering is only expressible as a whole-list write: the per-rule endpoint
    // deliberately keeps a rule's position so an edit cannot silently reorder.
    void mutate(`move-${index}`, () =>
      api.putRouting({ ...routing, rules: next }, "reorder routing rules"),
    ).catch(() => undefined);
  };

  const remove = (rule: RoutingRule, index: number) => {
    void mutate(`delete-${index}`, () => api.deleteRule(idOf(rule, index))).catch(() => undefined);
  };

  const probe = async (rule: RoutingRule, index: number) => {
    const id = idOf(rule, index);
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
      <PageHeader
        title="Model routing"
        description="One ordered list. The first rule whose condition matches wins, and its target carries the provider, the credentials and the upstream model. No match is a 404."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          >
            Add rule
          </Button>
        }
      />

      <PageBody>
        {error !== null ? (
          <Callout tone="danger" title="The change was rejected" role="alert">
            <p className="mt-1">{error}</p>
          </Callout>
        ) : null}

        {warnings.map((warning) => (
          <Callout key={warning} tone="warning" title="Saved, but read this" role="status">
            <p className="mt-1">{warning}</p>
          </Callout>
        ))}

        <Panel
          title="Rules"
          description={`${routing.rules.length} rule${routing.rules.length === 1 ? "" : "s"}, evaluated top to bottom.`}
        >
          {routing.rules.length === 0 ? (
            <p className="text-sm text-foreground-secondary">
              No rules yet, so every request to <span className="font-mono">/v1</span> is a 404. Add
              one with <span className="font-mono">when: true</span> to serve everything through a
              single upstream.
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {routing.rules.map((rule, index) => {
                const id = idOf(rule, index);
                const unreachable = catchAllAt !== -1 && index > catchAllAt;
                const result = probes[id];
                return (
                  <li
                    key={id}
                    className="flex flex-col gap-3 rounded-[var(--radius-field)] border border-border bg-background-grouped-content px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-foreground-secondary">
                        {index + 1}
                      </span>
                      <span className="text-sm font-medium text-foreground-primary">
                        {rule.name ?? id}
                      </span>
                      <Badge tone="accent">{rule.target.type}</Badge>
                      {rule.target.model !== undefined ? (
                        <Badge>{rule.target.model}</Badge>
                      ) : (
                        <Badge>passes the client’s model through</Badge>
                      )}
                      {rule.when.trim() === CATCH_ALL ? (
                        <Badge tone="success">catch-all</Badge>
                      ) : null}
                      {unreachable ? <Badge tone="danger">unreachable</Badge> : null}
                      <CredentialBadge target={rule.target} />
                    </div>

                    <code className="block overflow-x-auto whitespace-pre rounded-[6px] bg-background-grouped-container px-3 py-2 font-mono text-xs text-foreground-primary">
                      {rule.when}
                    </code>

                    {unreachable ? (
                      <p className="text-xs text-destructive">
                        A catch-all above this rule matches everything, so this rule can never fire.
                        Move it above rule {catchAllAt + 1}.
                      </p>
                    ) : null}

                    {result !== undefined ? <ProbeResult result={result} /> : null}

                    <div className="flex flex-wrap gap-2">
                      <Button
                        className="px-2 py-1 text-xs"
                        onClick={() => {
                          setEditing({ rule, index });
                          setEditorOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        className="px-2 py-1 text-xs"
                        disabled={result === "running"}
                        onClick={() => void probe(rule, index)}
                      >
                        {result === "running" ? "Testing…" : "Test upstream"}
                      </Button>
                      <Button
                        className="px-2 py-1 text-xs"
                        disabled={index === 0 || busy !== null}
                        aria-label={`Move ${id} up`}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        className="px-2 py-1 text-xs"
                        disabled={index === routing.rules.length - 1 || busy !== null}
                        aria-label={`Move ${id} down`}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </Button>
                      <Button
                        variant="ghost"
                        className="px-2 py-1 text-xs text-destructive"
                        disabled={busy !== null}
                        onClick={() => remove(rule, index)}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>

        <AllowedModelsPanel
          routing={routing}
          onSave={(allowedModels) =>
            mutate("allowed-models", () =>
              api.putRouting({ ...routing, allowedModels }, "update the client-facing model list"),
            )
          }
        />

        <SimulatePanel
          suggestedModel={routing.allowedModels[0] ?? routing.rules[0]?.target.model ?? null}
        />
      </PageBody>

      {editorOpen ? (
        <RuleEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          editing={editing}
          providers={meta.providers}
          takenIds={routing.rules
            .map((rule, index) => idOf(rule, index))
            .filter((id) => id !== (editing === null ? null : idOf(editing.rule, editing.index)))}
          onSubmit={(id, value) =>
            mutate("save-rule", () => api.putRule(id, value), { surfaceError: false })
          }
        />
      ) : null}
    </>
  );
}

/** Where this rule's credential comes from — never what it is. */
function CredentialBadge({ target }: { target: RoutingRule["target"] }) {
  for (const field of ["apiKey", "serviceAccountKey", "privateKey"] as const) {
    const value = target[field];
    if (isSecretRef(value)) return <Badge tone="success">sealed credential</Badge>;
    if (isEnvRef(value)) return <Badge tone="neutral">{String(value)}</Badge>;
    if (typeof value === "string" && value !== "") {
      // Only reachable on a deployment seeded from the environment with no
      // keyring configured, since the admin API seals anything it is given.
      return <Badge tone="warning">unsealed credential</Badge>;
    }
  }
  return null;
}

function ProbeResult({ result }: { result: ProbeResponse | "running" }) {
  if (result === "running") {
    return <p className="text-xs text-foreground-secondary">Contacting the upstream…</p>;
  }
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

/**
 * The client-facing catalogue.
 *
 * Enforced *before* any rule runs, and it is what `GET /v1/models` lists — so
 * this is the one place that decides what a client may ask for, independent of
 * what the rules can serve.
 */
function AllowedModelsPanel({
  routing,
  onSave,
}: {
  routing: RoutingBlock;
  onSave: (allowedModels: string[]) => Promise<void>;
}) {
  const stored = routing.allowedModels.join("\n");
  const [text, setText] = useState(stored);
  const [busy, setBusy] = useState(false);
  const dirty = text !== stored;

  const save = async () => {
    setBusy(true);
    try {
      await onSave(
        text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      );
    } catch {
      // `mutate` has already surfaced the reason at the top of the page.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Client-facing models"
      description="What a client may ask for. Anything else is a 404 before any rule runs, and GET /v1/models lists exactly these."
      actions={
        <>
          {dirty ? (
            <Button onClick={() => setText(stored)} disabled={busy}>
              Discard
            </Button>
          ) : null}
          <Button variant="primary" onClick={save} disabled={!dirty || busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <TextAreaField
        label="Allowed models"
        mono
        rows={4}
        value={text}
        hint="One per line. Leave empty to allow any name, in which case /v1/models falls back to the models the rules forward to."
        onChange={(event) => setText(event.target.value)}
      />
    </Panel>
  );
}
