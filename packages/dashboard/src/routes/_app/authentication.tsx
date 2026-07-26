import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { VerifierEditor } from "../../components/authentication/verifier-editor";
import { isEnvRef, isSecretRef, mergeCredentials } from "../../components/schema-form";
import { PageBody, PageHeader } from "../../components/shell";
import {
  Badge,
  Button,
  Callout,
  Panel,
  SelectField,
  TextAreaField,
  ToggleField,
} from "../../components/ui/primitives";
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

/** Human names for the verifier types, since a type slug reads as jargon. */
const VERIFIER_LABELS: Record<string, string> = {
  jwt: "Custom JWT",
  "firebase-auth": "Firebase Auth",
  supabase: "Supabase Auth",
  "firebase-app-check": "Firebase App Check",
  "apple-device-check": "Apple DeviceCheck",
  "apple-app-attest": "Apple App Attest",
};

/**
 * What each verifier answers.
 *
 * Worth spelling out on this screen because the distinction decides whether
 * `mode: "all"` is a sensible configuration: two verifiers answering the *same*
 * question means a client must satisfy both, while an app-attestation verifier
 * plus a user-token verifier is the pairing `all` exists for.
 */
const VERIFIER_AXIS: Record<string, "user" | "device"> = {
  jwt: "user",
  "firebase-auth": "user",
  supabase: "user",
  "firebase-app-check": "device",
  "apple-device-check": "device",
  "apple-app-attest": "device",
};

function securityOf(config: ConfigResponse): SecurityBlock {
  const security = config.config?.security;
  return {
    mode: security?.mode ?? "all",
    publicPaths: security?.publicPaths ?? [],
    requireWriteKey: security?.requireWriteKey ?? false,
    providers: security?.providers ?? [],
  };
}

const verifierKey = (entry: VerifierEntry, index: number): string =>
  `${entry.type}:${entry.name ?? index}`;

function AuthenticationScreen() {
  const { config, meta } = Route.useLoaderData();
  const router = useRouter();
  const security = securityOf(config);

  const [editing, setEditing] = useState<{ entry: VerifierEntry; index: number } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * `security` is replaced wholesale on every change.
   *
   * There is no per-verifier endpoint, and inventing one on the client would mean
   * merging on this side — where a stale list silently drops a verifier another
   * operator added in the meantime. Sending the whole block keeps the last write
   * visible as a last write.
   */
  const save = async (next: SecurityBlock, note: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.putSecurity(next, note);
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change could not be saved.");
      throw caught;
    } finally {
      setBusy(false);
    }
  };

  const upsert = async (entry: VerifierEntry, index: number | null) => {
    const providers = [...security.providers];
    if (index === null) providers.push(entry);
    else {
      const stored = providers[index];
      // A blank credential box means "keep what is stored", and the only way to
      // say that is to send the existing reference back unchanged.
      providers[index] =
        stored === undefined ? entry : { ...entry, ...mergeCredentials(entry, stored) };
    }
    await save(
      { ...security, providers },
      `${index === null ? "add" : "update"} the ${entry.type} verifier`,
    );
  };

  const remove = (index: number) => {
    const providers = security.providers.filter((_, at) => at !== index);
    // A bundle cannot exist without a verifier, so the API would reject this and
    // the previous configuration would keep serving. Saying so here is cheaper
    // than a round trip that can only fail.
    if (providers.length === 0) {
      setError(
        "At least one verifier is required. A proxy that authenticates nobody is an open relay on your provider credits, so removing the last one is refused.",
      );
      return;
    }
    void save({ ...security, providers }, "remove a verifier").catch(() => undefined);
  };

  const axes = new Set(security.providers.map((entry) => VERIFIER_AXIS[entry.type] ?? "user"));
  const modeIsRedundant =
    security.mode === "all" && axes.size === 1 && security.providers.length > 1;

  return (
    <>
      <PageHeader
        title="Client authentication"
        description="Who may call /v1. Verifiers establish the end user or the device; a write key says which app. Both axes are checked independently."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          >
            Add verifier
          </Button>
        }
      />

      <PageBody>
        {error !== null ? (
          <Callout tone="danger" title="The change was rejected" role="alert">
            <p className="mt-1">{error}</p>
          </Callout>
        ) : null}

        {security.providers.length === 0 ? (
          <Callout tone="danger" title="No verifier is configured" role="alert">
            <p className="mt-1">
              <span className="font-mono">/v1</span> is closed and returns 503 until at least one
              verifier exists. That is deliberate: a proxy that authenticates nobody would spend
              your provider credits for anyone who finds the URL.
            </p>
          </Callout>
        ) : null}

        <Panel
          title="Verifiers"
          description="Each one recognises its own credential and ignores requests that do not carry it."
        >
          {security.providers.length === 0 ? (
            <p className="text-sm text-foreground-secondary">
              Nothing configured yet. <span className="font-mono">jwt</span> with a shared secret
              needs no external service and is enough for local development.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {security.providers.map((entry, index) => (
                <li
                  key={verifierKey(entry, index)}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-field)] border border-border bg-background-grouped-content px-4 py-3"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground-primary">
                        {VERIFIER_LABELS[entry.type] ?? entry.type}
                      </span>
                      <Badge tone="accent">{entry.type}</Badge>
                      <Badge>
                        {VERIFIER_AXIS[entry.type] === "device"
                          ? "verifies the app"
                          : "verifies the user"}
                      </Badge>
                      <VerifierCredentialBadge entry={entry} />
                    </div>
                    {entry.name !== undefined ? (
                      <span className="font-mono text-xs text-foreground-secondary">
                        {entry.name}
                      </span>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <Button
                      className="px-2 py-1 text-xs"
                      onClick={() => {
                        setEditing({ entry, index });
                        setEditorOpen(true);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs text-destructive"
                      disabled={busy}
                      onClick={() => remove(index)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <ModePanel
          security={security}
          redundant={modeIsRedundant}
          busy={busy}
          onSave={(next, note) => save(next, note).catch(() => undefined)}
        />
      </PageBody>

      {editorOpen ? (
        <VerifierEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          editing={editing}
          verifiers={meta.authVerifiers}
          labels={VERIFIER_LABELS}
          onSubmit={(entry) => upsert(entry, editing?.index ?? null)}
        />
      ) : null}
    </>
  );
}

function VerifierCredentialBadge({ entry }: { entry: VerifierEntry }) {
  for (const field of ["secret", "jwtSecret", "privateKey", "serviceAccountKey"] as const) {
    const value = entry[field];
    if (isSecretRef(value)) return <Badge tone="success">sealed credential</Badge>;
    if (isEnvRef(value)) return <Badge>{String(value)}</Badge>;
    if (typeof value === "string" && value !== "") {
      return <Badge tone="warning">unsealed credential</Badge>;
    }
  }
  return null;
}

/**
 * How the verifiers combine, and the two settings that decide who else gets in.
 *
 * `requireWriteKey` is the sharp one: turning it on locks out every client that
 * is not already sending `x-omni-key`, which is why it defaults to off and why
 * the copy says so before the toggle is flipped rather than after.
 */
function ModePanel({
  security,
  redundant,
  busy,
  onSave,
}: {
  security: SecurityBlock;
  redundant: boolean;
  busy: boolean;
  onSave: (next: SecurityBlock, note: string) => void;
}) {
  const storedPaths = security.publicPaths.join("\n");
  const [paths, setPaths] = useState(storedPaths);
  const dirty = paths !== storedPaths;

  return (
    <Panel
      title="How requests are checked"
      description="Applies to every /v1 request, whichever verifier recognises it."
    >
      <div className="flex flex-col gap-5">
        <SelectField
          label="Verifier mode"
          value={security.mode}
          items={[
            { value: "all", label: "all — every verifier must accept" },
            { value: "any", label: "any — the first verifier that accepts wins" },
          ]}
          onValueChange={(mode) =>
            onSave({ ...security, mode }, `set the verifier mode to ${mode}`)
          }
          hint={
            security.mode === "all"
              ? "A client must satisfy every verifier. Right for an app attestation plus a user token."
              : "A presented-but-invalid credential still rejects the request; only absence falls through to the next verifier."
          }
        />

        {redundant ? (
          <Callout tone="warning">
            Every configured verifier answers the same question, and mode is{" "}
            <span className="font-mono">all</span> — so a client has to present all of their
            credentials at once. If you meant "any of these will do", switch the mode to{" "}
            <span className="font-mono">any</span>.
          </Callout>
        ) : null}

        <ToggleField
          label="Require a write key"
          description="Every /v1 request must carry x-omni-key. Turning this on locks out any client not already sending one — presented keys are validated either way, so attribution works before you enable it."
          checked={security.requireWriteKey}
          onCheckedChange={(requireWriteKey) =>
            onSave(
              { ...security, requireWriteKey },
              `${requireWriteKey ? "require" : "stop requiring"} a write key`,
            )
          }
        />

        <div className="flex flex-col gap-2">
          <TextAreaField
            label="Public paths"
            mono
            rows={3}
            value={paths}
            hint="Paths that bypass authentication entirely. One per line; a trailing * matches a prefix. Anything listed here is open to the internet."
            onChange={(event) => setPaths(event.target.value)}
          />
          {dirty ? (
            <div className="flex justify-end gap-2">
              <Button onClick={() => setPaths(storedPaths)} disabled={busy}>
                Discard
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  onSave(
                    {
                      ...security,
                      publicPaths: paths
                        .split("\n")
                        .map((line) => line.trim())
                        .filter((line) => line !== ""),
                    },
                    "update the public paths",
                  )
                }
              >
                {busy ? "Saving…" : "Save public paths"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
