import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import vendorApple from "../../assets/vendor-apple.svg";
import vendorAws from "../../assets/vendor-aws.svg";
import vendorClerk from "../../assets/vendor-clerk.svg";
import vendorCloudflare from "../../assets/vendor-cloudflare.svg";
import vendorFirebase from "../../assets/vendor-firebase.svg";
import vendorGoogle from "../../assets/vendor-google.svg";
import vendorJwt from "../../assets/vendor-jwt.svg";
import vendorSupabase from "../../assets/vendor-supabase.svg";
import { ActionBar, CenteredPane, PaneTitle } from "../../components/chrome";
import { mergeCredentials, type OptionValues, SchemaForm } from "../../components/schema-form";
import {
  Button,
  Callout,
  Card,
  Checkbox,
  Radio,
  SelectField,
  ThemedIcon,
} from "../../components/ui/primitives";
import {
  api,
  type ConfigResponse,
  type MetaResponse,
  type SecurityBlock,
  type VerifierEntry,
  type VerifierTestResponse,
} from "../../lib/api";
import { pageHead } from "../../lib/page-title";

export const Route = createFileRoute("/_app/authentication")({
  head: () => pageHead("Authentication"),
  loader: async (): Promise<{ config: ConfigResponse; meta: MetaResponse }> => {
    const [config, meta] = await Promise.all([api.config(), api.meta()]);
    return { config, meta };
  },
  component: AuthenticationScreen,
});

/**
 * How each verifier is drawn, keyed by type.
 *
 * The *set* of cards comes from `GET /meta`, and so does which layer each one
 * belongs to — a verifier added to the registry appears in the right half with no
 * change here. This table only supplies presentation: the design's title, its
 * glyph, and the fields the file draws.
 *
 * `fields` is curated. Each verifier accepts more options than the design shows,
 * and rendering all of them turns a two-control card into a form; `SchemaForm`
 * appends anything *required* the list misses, so a curated card can never hide a
 * field a save needs.
 */
const PRESENTATION: Record<
  string,
  { title: string; icon: string; fields: readonly string[]; monochrome?: boolean }
> = {
  "firebase-auth": {
    title: "Firebase",
    icon: vendorFirebase,
    fields: ["projectId", "apiKey"],
  },
  clerk: {
    title: "Clerk",
    icon: vendorClerk,
    fields: ["issuer", "authorizedParties", "audience", "allowPendingSessions"],
  },
  "aws-cognito": {
    title: "AWS Cognito",
    icon: vendorAws,
    fields: ["region", "userPoolId", "clientIds", "tokenUse", "requiredScopes"],
  },
  supabase: { title: "Supabase Auth", icon: vendorSupabase, fields: ["baseUrl", "jwksUrl"] },
  jwt: {
    title: "Custom JWT",
    icon: vendorJwt,
    fields: ["publicKey", "secret", "issuer", "algorithms"],
    monochrome: true,
  },
  "firebase-app-check": {
    title: "Firebase App Check",
    icon: vendorFirebase,
    fields: ["projectNumber", "appIds", "consume"],
  },
  "cloudflare-turnstile": {
    title: "Cloudflare Turnstile",
    icon: vendorCloudflare,
    fields: ["secret", "action", "hostnames"],
  },
  "recaptcha-enterprise": {
    title: "reCAPTCHA Enterprise",
    icon: vendorGoogle,
    fields: ["projectId", "siteKey", "apiKey", "expectedAction", "minScore", "hostnames"],
  },
  "google-play-integrity": {
    title: "Google Play Integrity",
    icon: vendorGoogle,
    fields: [
      "packageName",
      "serviceAccountKey",
      "deviceRecognitionVerdicts",
      "requireLicensed",
      "certificateSha256Digests",
    ],
  },
  "apple-app-attest": {
    title: "App Attest",
    icon: vendorApple,
    fields: ["teamId", "bundleId"],
    monochrome: true,
  },
  "apple-device-check": {
    title: "DeviceCheck",
    icon: vendorApple,
    fields: ["teamId", "keyId", "privateKey"],
    monochrome: true,
  },
};

/** The design's order within each layer; anything unlisted follows, alphabetically. */
const ORDER = [
  "firebase-auth",
  "clerk",
  "aws-cognito",
  "supabase",
  "jwt",
  "firebase-app-check",
  "cloudflare-turnstile",
  "recaptcha-enterprise",
  "google-play-integrity",
  "apple-app-attest",
  "apple-device-check",
];

function ordered(types: readonly string[]): string[] {
  return [
    ...ORDER.filter((type) => types.includes(type)),
    ...types.filter((type) => !ORDER.includes(type)).sort(),
  ];
}

function verifierIcon(type: string, fallback: string) {
  const presentation = PRESENTATION[type];
  const icon = presentation?.icon ?? fallback;
  return presentation?.monochrome === true ? (
    <ThemedIcon src={icon} className="size-[20px] text-foreground-primary" />
  ) : (
    <img src={icon} alt="" aria-hidden className="size-[20px] shrink-0" />
  );
}

const titleOf = (type: string): string => PRESENTATION[type]?.title ?? type;
const fieldsOf = (type: string): readonly string[] => PRESENTATION[type]?.fields ?? [];

function securityOf(config: ConfigResponse): SecurityBlock {
  const security = config.config?.security;
  return {
    userAuth: security?.userAuth ?? null,
    appAuth: {
      mode: security?.appAuth?.mode ?? "all",
      providers: security?.appAuth?.providers ?? [],
    },
    publicPaths: security?.publicPaths ?? [],
    requireWriteKey: security?.requireWriteKey ?? false,
  };
}

/** An entry's options, minus the discriminator a form must not render. */
function optionsOf(entry: VerifierEntry | null | undefined): OptionValues {
  if (entry === null || entry === undefined) return {};
  const { type: _type, ...options } = entry;
  return options;
}

/** One app-layer entry out of a block, by type. */
function findApp(block: SecurityBlock, type: string): VerifierEntry | undefined {
  return block.appAuth.providers.find((entry) => entry.type === type);
}

function ConfigurationTestResult({ result }: { result: VerifierTestResponse }) {
  if (result.ok === null) {
    return (
      <Callout tone="info" title="A full preflight is not available" role="status">
        {result.reason}
      </Callout>
    );
  }
  return (
    <Callout
      tone={result.ok ? "success" : "danger"}
      title={result.ok ? "Configuration verified" : "Configuration check failed"}
      role="status"
    >
      {result.message}
    </Callout>
  );
}

function AuthenticationScreen() {
  const { config, meta } = Route.useLoaderData();
  const router = useRouter();
  const stored = securityOf(config);

  const userTypes = ordered(
    meta.authVerifiers.filter((entry) => entry.layer === "user").map((entry) => entry.type),
  );
  const appTypes = ordered(
    meta.authVerifiers.filter((entry) => entry.layer === "app").map((entry) => entry.type),
  );

  /**
   * The whole block is edited locally and committed by the action bar.
   *
   * That is the design's model — a screen accumulates changes and one Save Changes
   * writes them — and it is also the only shape that can express "switch to
   * Firebase *and* fill in its project id" as one valid configuration. Saving per
   * control would have to persist a half-configured verifier, which the API would
   * rightly reject.
   */
  const [draft, setDraft] = useState<SecurityBlock>(stored);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, VerifierTestResponse | "testing" | undefined>>(
    {},
  );

  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  const chosen = draft.userAuth?.type ?? null;

  /**
   * Switching the user method replaces it rather than merging.
   *
   * Options belong to a verifier type — a Firebase project id means nothing to the
   * jwt verifier — so carrying them across would submit keys the new factory
   * rejects. Coming back to a method starts from what is *stored* for it, so a
   * switch away and back is not a way to lose a configuration.
   */
  const chooseUser = (type: string) => {
    if (type === chosen) return;
    const previous = stored.userAuth?.type === type ? optionsOf(stored.userAuth) : {};
    setTests((now) => ({ ...now, [type]: undefined }));
    setDraft((now) => ({ ...now, userAuth: { type, ...previous } }));
  };

  const setUserOptions = (options: OptionValues) => {
    if (chosen !== null) setTests((now) => ({ ...now, [chosen]: undefined }));
    setDraft((now) =>
      now.userAuth === null ? now : { ...now, userAuth: { type: now.userAuth.type, ...options } },
    );
  };

  const appEnabled = (type: string): boolean =>
    draft.appAuth.providers.some((entry) => entry.type === type);

  const toggleApp = (type: string, on: boolean) => {
    setTests((now) => ({ ...now, [type]: undefined }));
    setDraft((now) => ({
      ...now,
      appAuth: {
        ...now.appAuth,
        providers: on
          ? [...now.appAuth.providers, { type, ...optionsOf(findApp(stored, type)) }]
          : now.appAuth.providers.filter((entry) => entry.type !== type),
      },
    }));
  };

  const setAppOptions = (type: string, options: OptionValues) => {
    setTests((now) => ({ ...now, [type]: undefined }));
    setDraft((now) => ({
      ...now,
      appAuth: {
        ...now.appAuth,
        providers: now.appAuth.providers.map((entry) =>
          entry.type === type ? { type, ...options } : entry,
        ),
      },
    }));
  };

  const candidate = (
    entry: VerifierEntry,
    previous: VerifierEntry | null | undefined,
  ): VerifierEntry => ({
    type: entry.type,
    ...mergeCredentials(optionsOf(entry), optionsOf(previous)),
  });

  const testConfiguration = async (
    entry: VerifierEntry,
    previous: VerifierEntry | null | undefined,
  ) => {
    const type = entry.type;
    setTests((now) => ({ ...now, [type]: "testing" }));
    try {
      const result = await api.testVerifier(candidate(entry, previous));
      setTests((now) => ({ ...now, [type]: result }));
    } catch (caught) {
      setTests((now) => ({
        ...now,
        [type]: {
          ok: false,
          message: caught instanceof Error ? caught.message : "The configuration check failed.",
        },
      }));
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // A blank credential box means "keep what is stored", and the only way to
      // say that is to send the existing reference back unchanged.
      const userAuth =
        draft.userAuth === null
          ? null
          : {
              type: draft.userAuth.type,
              // Only merge against the *same* method's stored options: a jwt secret
              // is not a Firebase credential, and carrying it across a switch would
              // send the new factory a key it rejects.
              ...mergeCredentials(
                optionsOf(draft.userAuth),
                draft.userAuth.type === stored.userAuth?.type ? optionsOf(stored.userAuth) : {},
              ),
            };
      const providers = draft.appAuth.providers.map((entry) => ({
        type: entry.type,
        ...mergeCredentials(optionsOf(entry), optionsOf(findApp(stored, entry.type))),
      }));
      await api.putSecurity(
        { ...draft, userAuth, appAuth: { ...draft.appAuth, providers } },
        "update client authentication",
      );
      setTests({});
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
      <ActionBar
        dirty={dirty}
        busy={busy}
        onDiscard={() => {
          setDraft(stored);
          setTests({});
        }}
        onSave={save}
      />

      <CenteredPane>
        {error !== null ? (
          <Callout tone="danger" title="The change was rejected" role="alert">
            <p className="mt-[4px]">{error}</p>
          </Callout>
        ) : null}

        <PaneTitle>User Authentication</PaneTitle>

        <p className="type-label-12 w-full text-foreground-secondary">
          Which user is calling. One method, and it is required: token budgets are counted per user,
          so a request that does not say who it is has nothing to spend.
        </p>

        {draft.userAuth === null ? (
          <Callout tone="danger" title="No user authentication is set" role="alert">
            <p className="mt-[4px]">
              <span className="type-mono-12">/v1</span> is closed and returns 503 until one is
              chosen. That is deliberate: a proxy that authenticates nobody would spend your
              provider credits for anyone who finds the URL.
            </p>
          </Callout>
        ) : null}

        <div className="flex w-full flex-col gap-[12px]">
          {userTypes.map((type) => (
            <Card
              key={type}
              title={titleOf(type)}
              icon={verifierIcon(type, vendorJwt)}
              actions={
                <div className="flex items-center gap-[8px]">
                  {chosen === type && draft.userAuth !== null ? (
                    <Button
                      size="medium"
                      disabled={tests[type] === "testing"}
                      onClick={() =>
                        void testConfiguration(
                          draft.userAuth as VerifierEntry,
                          stored.userAuth?.type === type ? stored.userAuth : null,
                        )
                      }
                    >
                      {tests[type] === "testing" ? "Testing…" : "Test configuration"}
                    </Button>
                  ) : null}
                  <Radio
                    name="user-auth"
                    label={`Use ${titleOf(type)}`}
                    checked={chosen === type}
                    onSelect={() => chooseUser(type)}
                  />
                </div>
              }
            >
              {chosen === type ? (
                <SchemaForm
                  schema={schemaFor(type)}
                  values={optionsOf(draft.userAuth)}
                  only={fieldsOf(type)}
                  omit={["type", "name"]}
                  componentType={type}
                  idPrefix={`verifier-${type}`}
                  onChange={setUserOptions}
                />
              ) : (
                <p className="type-label-12 text-foreground-secondary">
                  Not in use. Select it to configure it.
                </p>
              )}
              {chosen === type && tests[type] !== undefined && tests[type] !== "testing" ? (
                <ConfigurationTestResult result={tests[type]} />
              ) : null}
            </Card>
          ))}
        </div>

        <PaneTitle>App Authentication</PaneTitle>

        <p className="type-label-12 w-full text-foreground-secondary">
          Which app the request came from, layered over the user. Optional, and any number of them —
          one scheme per platform is normal. A valid user token sent from something that is not your
          app is what these exist to stop.
        </p>

        <SelectField
          className="w-[518px] max-w-full"
          label="When more than one is enabled"
          value={draft.appAuth.mode}
          items={[
            { value: "all", label: "Client must pass all of them" },
            { value: "any", label: "Client must pass any one of them" },
          ]}
          onValueChange={(mode) =>
            setDraft((now) => ({ ...now, appAuth: { ...now.appAuth, mode } }))
          }
          help={
            draft.appAuth.mode === "all"
              ? "Every enabled scheme must accept. Right for one platform layering two schemes — and wrong for several, since a client can only satisfy its own."
              : "The first enabled scheme that accepts wins. Right for several platforms. A presented-but-invalid credential still rejects; only absence falls through."
          }
        />

        <div className="flex w-full flex-col gap-[12px]">
          {appTypes.map((type) => (
            <Card
              key={type}
              title={titleOf(type)}
              icon={verifierIcon(type, vendorApple)}
              actions={
                <div className="flex items-center gap-[8px]">
                  {appEnabled(type) ? (
                    <Button
                      size="medium"
                      disabled={tests[type] === "testing"}
                      onClick={() => {
                        const entry = findApp(draft, type);
                        if (entry !== undefined) {
                          void testConfiguration(entry, findApp(stored, type));
                        }
                      }}
                    >
                      {tests[type] === "testing" ? "Testing…" : "Test configuration"}
                    </Button>
                  ) : null}
                  <Checkbox
                    aria-label={`Enable ${titleOf(type)}`}
                    checked={appEnabled(type)}
                    onCheckedChange={(on) => toggleApp(type, on)}
                  />
                </div>
              }
            >
              {appEnabled(type) ? (
                <SchemaForm
                  schema={schemaFor(type)}
                  values={optionsOf(findApp(draft, type))}
                  only={fieldsOf(type)}
                  omit={["type", "name"]}
                  componentType={type}
                  idPrefix={`verifier-${type}`}
                  onChange={(options) => setAppOptions(type, options)}
                />
              ) : (
                <p className="type-label-12 text-foreground-secondary">
                  Not enabled. Tick the box to configure it.
                </p>
              )}
              {appEnabled(type) && tests[type] !== undefined && tests[type] !== "testing" ? (
                <ConfigurationTestResult result={tests[type]} />
              ) : null}
            </Card>
          ))}
        </div>
      </CenteredPane>
    </>
  );
}
