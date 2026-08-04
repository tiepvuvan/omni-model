import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import deleteIcon from "../../assets/delete.svg";
import plusIcon from "../../assets/plus.svg";
import { ActionBar, WidePane } from "../../components/chrome";
import {
  ProviderPicker,
  VENDOR_TITLES,
  VendorIcon,
} from "../../components/routing/provider-picker";
import { mergeCredentials, SchemaForm } from "../../components/schema-form";
import { Button, Callout, Card, IconButton } from "../../components/ui/primitives";
import {
  api,
  type ConfigResponse,
  type MetaResponse,
  type ProviderEntry,
  type ProvidersBlock,
} from "../../lib/api";
import { pageHead } from "../../lib/page-title";
import { PREFERRED_PROVIDERS, preferredType } from "../../lib/preferred";
import { providerOptions, starterProviders } from "../../lib/provider-config";

export const Route = createFileRoute("/_app/providers")({
  head: () => pageHead("Providers"),
  loader: async (): Promise<{ config: ConfigResponse; meta: MetaResponse }> => {
    const [config, meta] = await Promise.all([api.config(), api.meta()]);
    return { config, meta };
  },
  component: ProvidersScreen,
});

function providersOf(config: ConfigResponse): ProvidersBlock {
  return config.config?.providers ?? {};
}

function ProvidersScreen() {
  const { config, meta } = Route.useLoaderData();
  const router = useRouter();
  const stored = providersOf(config);
  const [draft, setDraft] = useState<ProvidersBlock>(() =>
    Object.keys(stored).length === 0 ? starterProviders() : stored,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<
    Record<
      string,
      | "testing"
      | { ok: boolean | null; models: string[]; status?: number | null; reason?: string }
      | undefined
    >
  >({});

  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  const availableTypes = meta.providers.map((entry) => entry.type);
  const firstType = preferredType(meta.providers, PREFERRED_PROVIDERS);

  const update = (id: string, entry: ProviderEntry) => {
    setTests((now) => ({ ...now, [id]: undefined }));
    setDraft((now) => ({ ...now, [id]: entry }));
  };

  const add = () => {
    let number = Object.keys(draft).length + 1;
    while (`provider-${number}` in draft) number += 1;
    const id = `provider-${number}`;
    setDraft((now) => ({ ...now, [id]: { type: firstType } }));
  };

  const remove = (id: string) => {
    setTests((now) => ({ ...now, [id]: undefined }));
    setDraft((now) => Object.fromEntries(Object.entries(now).filter(([key]) => key !== id)));
  };

  const test = async (id: string, entry: ProviderEntry) => {
    setTests((now) => ({ ...now, [id]: "testing" }));
    const previous = stored[id]?.type === entry.type ? stored[id] : undefined;
    const candidate = {
      type: entry.type,
      ...mergeCredentials(providerOptions(entry), providerOptions(previous)),
    };
    try {
      const result = await api.listUpstreamModels(candidate);
      setTests((now) => ({ ...now, [id]: result }));
    } catch (caught) {
      setTests((now) => ({
        ...now,
        [id]: {
          ok: false,
          models: [],
          reason: caught instanceof Error ? caught.message : "The provider check failed.",
        },
      }));
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const value = Object.fromEntries(
        Object.entries(draft).map(([id, entry]) => {
          const previous = stored[id]?.type === entry.type ? stored[id] : undefined;
          return [
            id,
            {
              type: entry.type,
              ...mergeCredentials(providerOptions(entry), providerOptions(previous)),
            },
          ];
        }),
      );
      await api.putProviders(value, "update model providers");
      setTests({});
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The providers could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ActionBar
        dirty={dirty}
        busy={busy}
        onDiscard={() => {
          setDraft(stored);
          setTests({});
        }}
        onSave={save}
      />

      <WidePane>
        <div className="flex max-w-[760px] flex-col gap-[8px]">
          <h1 className="type-heading-20 text-foreground-primary">Providers</h1>
          <p className="type-label-12 text-foreground-secondary">
            Configure upstream endpoints and credentials once. Routing rules select these provider
            IDs and never store keys themselves.
          </p>
        </div>

        {error !== null ? (
          <Callout tone="danger" title="The change was rejected" role="alert">
            {error}
          </Callout>
        ) : null}

        {Object.entries(draft).map(([id, entry]) => {
          const schema =
            meta.providers.find((descriptor) => descriptor.type === entry.type)?.optionsSchema ??
            null;
          const verdict = tests[id];
          return (
            <Card
              key={id}
              title={id}
              icon={<VendorIcon type={entry.type} size={24} />}
              actions={
                <div className="flex items-center gap-[8px]">
                  <ProviderPicker
                    available={availableTypes}
                    value={entry.type}
                    onChange={(type) => update(id, { type })}
                  />
                  <Button
                    size="medium"
                    disabled={verdict === "testing"}
                    onClick={() => void test(id, entry)}
                  >
                    {verdict === "testing" ? "Testing…" : "Test configuration"}
                  </Button>
                  <IconButton icon={deleteIcon} label={`Remove ${id}`} onClick={() => remove(id)} />
                </div>
              }
              bodyClassName="gap-[12px]"
            >
              <p className="type-label-12 text-foreground-secondary">
                Provider ID: <span className="type-mono-12">{id}</span> ·{" "}
                {VENDOR_TITLES[entry.type] ?? entry.type}
              </p>
              <SchemaForm
                schema={schema}
                values={providerOptions(entry)}
                omit={["type", "name"]}
                componentType={entry.type}
                idPrefix={`provider-${id}`}
                onChange={(options) => update(id, { type: entry.type, ...options })}
              />
              {verdict !== undefined && verdict !== "testing" ? (
                <Callout
                  tone={verdict.ok === true ? "success" : verdict.ok === false ? "danger" : "info"}
                  title={
                    verdict.ok === true
                      ? "Provider verified"
                      : verdict.ok === false
                        ? "Provider check failed"
                        : "No upstream check is available"
                  }
                  role="status"
                >
                  {verdict.ok === true
                    ? `${verdict.models.length} model${verdict.models.length === 1 ? "" : "s"} available.`
                    : (verdict.reason ??
                      `The upstream rejected this configuration (HTTP ${verdict.status ?? "error"}).`)}
                </Callout>
              ) : null}
            </Card>
          );
        })}

        <Button icon={plusIcon} onClick={add} className="self-start">
          Provider
        </Button>
      </WidePane>
    </>
  );
}
