import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import vendorApple from "../../assets/vendor-apple.svg";
import vendorFirebase from "../../assets/vendor-firebase.svg";
import vendorJwt from "../../assets/vendor-jwt.svg";
import vendorSupabase from "../../assets/vendor-supabase.svg";
import { ActionBar, CenteredPane, PaneTitle } from "../../components/chrome";
import { mergeCredentials, type OptionValues, SchemaForm } from "../../components/schema-form";
import { Callout, Card, Checkbox, SelectField } from "../../components/ui/primitives";
import {
  api,
  type ConfigResponse,
  type MetaResponse,
  type SecurityBlock,
  type VerifierEntry,
} from "../../lib/api";

export const Route = createFileRoute("/_app/authentication")({
  loader: async (): Promise<{ config: ConfigResponse; meta: MetaResponse }> => {
    const [config, meta] = await Promise.all([api.config(), api.meta()]);
    return { config, meta };
  },
  component: AuthenticationScreen,
});

/**
 * The cards the design draws, in its order.
 *
 * A card is not always one verifier: the Firebase card owns `firebase-auth` and,
 * behind its own checkbox, `firebase-app-check`. That is the design's grouping —
 * an operator thinks "Firebase", not "two entries in a providers array" — and it
 * is only expressible by letting a card cover more than one type.
 */
const CARDS: readonly {
  key: string;
  title: string;
  icon: string;
  /** The verifier this card's checkbox enables. */
  type: string;
  /**
   * The fields the design draws, in its order.
   *
   * A curated list rather than the whole schema: each verifier accepts more
   * options than the file shows, and rendering all of them turns a five-control
   * card into a form. Anything *required* that this list misses is appended
   * anyway, so a curated screen can never hide a field a save needs.
   */
  fields: readonly string[];
  /** A second verifier, behind a nested checkbox. */
  extra?: { type: string; label: string; fields: readonly string[] };
}[] = [
  {
    key: "firebase",
    title: "Firebase",
    icon: vendorFirebase,
    type: "firebase-auth",
    fields: ["projectId"],
    extra: {
      type: "firebase-app-check",
      label: "Enable App Check",
      fields: ["projectNumber", "appIds", "consume"],
    },
  },
  {
    key: "supabase",
    title: "Supabase Auth",
    icon: vendorSupabase,
    type: "supabase",
    fields: ["baseUrl", "jwksUrl"],
  },
  {
    key: "jwt",
    title: "Custom JWT",
    icon: vendorJwt,
    type: "jwt",
    fields: ["publicKey", "secret", "issuer", "algorithms"],
  },
  {
    key: "app-attest",
    title: "App Attest",
    icon: vendorApple,
    type: "apple-app-attest",
    fields: ["teamId", "bundleId"],
  },
  {
    key: "device-check",
    title: "DeviceCheck",
    icon: vendorApple,
    type: "apple-device-check",
    fields: ["teamId", "keyId", "privateKey"],
  },
];

function securityOf(config: ConfigResponse): SecurityBlock {
  const security = config.config?.security;
  return {
    mode: security?.mode ?? "all",
    publicPaths: security?.publicPaths ?? [],
    requireWriteKey: security?.requireWriteKey ?? false,
    providers: security?.providers ?? [],
  };
}

/** Options for one verifier type out of the block, minus the discriminator. */
function optionsFor(providers: readonly VerifierEntry[], type: string): OptionValues | null {
  const entry = providers.find((provider) => provider.type === type);
  if (entry === undefined) return null;
  const { type: _type, ...options } = entry;
  return options;
}

function AuthenticationScreen() {
  const { config, meta } = Route.useLoaderData();
  const router = useRouter();
  const stored = securityOf(config);

  /**
   * The whole block is edited locally and committed by the action bar.
   *
   * That is the design's model — a screen accumulates changes and one Save
   * Changes writes them — and it is also the only shape that can express
   * "enable Firebase *and* fill in its project id" as a single valid
   * configuration. Saving per control would have to persist an enabled verifier
   * with no options, which the API would rightly reject.
   */
  const [draft, setDraft] = useState<SecurityBlock>(stored);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);

  const enabled = (type: string): boolean =>
    draft.providers.some((provider) => provider.type === type);

  const toggle = (type: string, on: boolean) => {
    setDraft((now) => ({
      ...now,
      providers: on
        ? [...now.providers, { type }]
        : now.providers.filter((provider) => provider.type !== type),
    }));
  };

  const setOptions = (type: string, options: OptionValues) => {
    setDraft((now) => ({
      ...now,
      providers: now.providers.map((provider) =>
        provider.type === type ? { type, ...options } : provider,
      ),
    }));
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // A blank credential box means "keep what is stored", and the only way to
      // say that is to send the existing reference back unchanged.
      const providers = draft.providers.map((provider) => {
        const previous = optionsFor(stored.providers, provider.type);
        if (previous === null) return provider;
        const { type, ...options } = provider;
        return { type, ...mergeCredentials(options, previous) };
      });
      await api.putSecurity({ ...draft, providers }, "update client authentication");
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const schemaFor = (type: string) =>
    meta.authVerifiers.find((entry) => entry.type === type)?.optionsSchema ?? null;

  return (
    <>
      <ActionBar dirty={dirty} busy={busy} onDiscard={() => setDraft(stored)} onSave={save} />

      <CenteredPane>
        <PaneTitle>User Authentication</PaneTitle>

        {error !== null ? (
          <Callout tone="danger" title="The change was rejected" role="alert">
            <p className="mt-[4px]">{error}</p>
          </Callout>
        ) : null}

        {draft.providers.length === 0 ? (
          <Callout tone="danger" title="No verifier is enabled" role="alert">
            <p className="mt-[4px]">
              <span className="type-mono-12">/v1</span> is closed and returns 503 until at least one
              is. That is deliberate: a proxy that authenticates nobody would spend your provider
              credits for anyone who finds the URL.
            </p>
          </Callout>
        ) : null}

        {/*
         * The design labels this select "Project ID", which is a stray label in
         * the file — its value and help text are both about how the enabled
         * methods combine, and there is a real Project ID field inside the
         * Firebase card below. Labelled for what it does.
         */}
        <SelectField
          className="w-[518px] max-w-full"
          label="Match mode"
          value={draft.mode}
          items={[
            { value: "all", label: "Client must match all of following" },
            { value: "any", label: "Client must match any of following" },
          ]}
          onValueChange={(mode) => setDraft((now) => ({ ...now, mode }))}
          help={
            draft.mode === "all"
              ? "Client must pass all of these enabled authentication methods. See documentation for what token needs to be send from client."
              : "The first enabled method that accepts wins. A presented-but-invalid credential still rejects the request; only absence falls through."
          }
        />

        <div className="flex w-full flex-col gap-[12px]">
          {CARDS.map((card) => (
            <Card
              key={card.key}
              title={card.title}
              icon={<img src={card.icon} alt="" aria-hidden className="size-[20px] shrink-0" />}
              actions={
                <Checkbox
                  aria-label={`Enable ${card.title}`}
                  checked={enabled(card.type)}
                  onCheckedChange={(on) => toggle(card.type, on)}
                />
              }
            >
              {enabled(card.type) ? (
                <>
                  <SchemaForm
                    schema={schemaFor(card.type)}
                    values={optionsFor(draft.providers, card.type) ?? {}}
                    only={card.fields}
                    omit={["type", "name"]}
                    idPrefix={`verifier-${card.type}`}
                    onChange={(options) => setOptions(card.type, options)}
                  />

                  {card.extra !== undefined ? (
                    <>
                      <Checkbox
                        label={card.extra.label}
                        checked={enabled(card.extra.type)}
                        onCheckedChange={(on) => toggle(card.extra?.type ?? "", on)}
                      />
                      {enabled(card.extra.type) ? (
                        <SchemaForm
                          schema={schemaFor(card.extra.type)}
                          values={optionsFor(draft.providers, card.extra.type) ?? {}}
                          only={card.extra.fields}
                          omit={["type", "name"]}
                          idPrefix={`verifier-${card.extra.type}`}
                          onChange={(options) => setOptions(card.extra?.type ?? "", options)}
                        />
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : (
                <p className="type-label-12 text-foreground-secondary">
                  Not enabled. Tick the box to configure it.
                </p>
              )}
            </Card>
          ))}
        </div>
      </CenteredPane>
    </>
  );
}
