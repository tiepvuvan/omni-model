import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import copyIcon from "../../assets/copy.svg";
import plusIcon from "../../assets/plus.svg";
import { Button, Callout, cx, Modal, TextField, ThemedIcon } from "../../components/ui/primitives";
import { api, type CreatedPublishableKey, type PublishableKey } from "../../lib/api";
import { pageHead } from "../../lib/page-title";

export const Route = createFileRoute("/_app/publishable-keys")({
  head: () => pageHead("Public API Keys"),
  loader: () => api.publishableKeys(),
  component: PublishableKeysScreen,
});

const number = new Intl.NumberFormat("en-US");

function date(value: number): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function requestTime(value: number | null): string {
  if (value === null) return "Never";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1_000));
  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} hours ago`;
  return date(value);
}

function KeyTable({
  keys,
  busyId,
  onRevoke,
}: {
  keys: PublishableKey[];
  busyId: string | null;
  onRevoke: (key: PublishableKey) => void;
}) {
  if (keys.length === 0) {
    return (
      <div className="border-b border-solid border-border px-[24px] py-[32px] type-copy-14 text-foreground-secondary">
        No publishable keys yet. Create one to connect an OpenAI-compatible client.
      </div>
    );
  }

  const cell = "h-[44px] border-b border-solid border-border px-[12px] text-left align-middle";
  const headings = [
    "Reference name",
    "Expire",
    "Total tokens",
    "Last used",
    "Actions",
    "Request time",
  ];
  return (
    <div className="w-full overflow-x-auto">
      <table aria-label="Publishable keys" className="w-full min-w-[840px] table-fixed">
        <colgroup>
          <col className="w-[19%]" />
          <col className="w-[15%]" />
          <col className="w-[16%]" />
          <col className="w-[18%]" />
          <col className="w-[14%]" />
          <col className="w-[18%]" />
        </colgroup>
        <thead>
          <tr>
            {headings.map((heading) => (
              <th
                key={heading}
                scope="col"
                className={cx(cell, "type-strong-14 text-foreground-primary")}
              >
                {heading === "Actions" ? <span className="sr-only">{heading}</span> : heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            const revoked = key.disabledAt !== null;
            return (
              <tr key={key.id}>
                <td className={cx(cell, "type-copy-14")}>
                  <span className="block truncate text-foreground-primary">{key.name}</span>
                </td>
                <td className={cx(cell, "type-copy-14 text-foreground-secondary")}>
                  {key.expiresAt === null ? "Never" : date(key.expiresAt)}
                </td>
                <td className={cx(cell, "type-copy-14 text-foreground-primary")}>
                  {number.format(key.usage.totalTokens)} tokens
                </td>
                <td className={cx(cell, "type-copy-14 text-foreground-primary")}>
                  <span className="block truncate">{key.usage.lastModel ?? "Never"}</span>
                </td>
                <td className={cell}>
                  <Button
                    size="medium"
                    disabled={revoked || busyId === key.id}
                    onClick={() => onRevoke(key)}
                  >
                    {revoked ? "Revoked" : busyId === key.id ? "Revoking…" : "Revoke"}
                  </Button>
                </td>
                <td className={cx(cell, "type-copy-14 text-foreground-primary")}>
                  {requestTime(key.usage.lastUsedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PublishableKeysScreen() {
  const keys = Route.useLoaderData();
  const router = useRouter();
  const [tab, setTab] = useState<"keys" | "instructions">("keys");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedPublishableKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetDialog = () => {
    setName("");
    setCreated(null);
    setCopied(false);
    setError(null);
  };

  const create = async () => {
    const referenceName = name.trim();
    if (referenceName === "") {
      setError("Enter a reference name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.createPublishableKey(referenceName);
      setCreated(result);
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The key could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (created === null) return;
    try {
      await navigator.clipboard.writeText(created.secret);
      setCopied(true);
    } catch {
      setError("The browser could not copy the key. Select and copy it manually.");
    }
  };

  const revoke = async (key: PublishableKey) => {
    if (!window.confirm(`Revoke “${key.name}”? Requests using it will stop working.`)) return;
    setBusyId(key.id);
    setError(null);
    try {
      await api.revokePublishableKey(key.id);
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The key could not be revoked.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <section className="flex flex-col border-b border-solid border-border px-[24px] pt-[32px]">
        <div className="flex items-start justify-between gap-[32px]">
          <div className="flex w-[511px] max-w-full flex-col gap-[6px]">
            <h1 className="type-heading-20 text-foreground-primary">Public API Keys</h1>
            <p className="type-copy-14 text-foreground-secondary">
              A key identifies the client, attributes its usage, and can be revoked. It is safe to
              include in a client application. Configure the end-user identity separately in{" "}
              <Link to="/authentication" className="text-accent-primary hover:underline">
                Authentication Settings
              </Link>
              .
            </p>
          </div>
          <Button
            variant="primary"
            icon={plusIcon}
            onClick={() => {
              resetDialog();
              setDialogOpen(true);
            }}
          >
            Public API Key
          </Button>
        </div>

        <div role="tablist" aria-label="Publishable key sections" className="mt-[16px] flex">
          {(["keys", "instructions"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cx(
                "border-b-2 px-[12px] py-[10px] type-strong-14",
                tab === value
                  ? "border-accent-primary text-accent-primary"
                  : "border-transparent text-foreground-primary",
              )}
            >
              {value === "keys" ? "Keys" : "Instruction"}
            </button>
          ))}
        </div>
      </section>

      {error !== null && !dialogOpen ? (
        <div className="p-[24px]">
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        </div>
      ) : null}

      {tab === "keys" ? (
        <KeyTable keys={keys} busyId={busyId} onRevoke={revoke} />
      ) : (
        <section className="flex max-w-[760px] flex-col gap-[16px] p-[24px]">
          <h2 className="type-strong-14 text-foreground-primary">OpenAI-compatible setup</h2>
          <p className="type-copy-14 text-foreground-secondary">
            Pass the publishable key as your OpenAI SDK API key. The SDK sends it as{" "}
            <span className="type-mono-12">Authorization: Bearer &lt;key&gt;</span>.
          </p>
          <pre className="overflow-x-auto rounded-[var(--radius-field)] border border-solid border-border bg-background-l1 p-[16px] type-mono-12 text-foreground-primary">
            {`const client = new OpenAI({
  apiKey: "omk_…",
  baseURL: "https://your-proxy.example/v1",
  defaultHeaders: {
    "X-Firebase-ID-Token": userIdToken,
  },
});`}
          </pre>
          <p className="type-label-12 text-foreground-secondary">
            Other user providers use their own token header, such as X-Clerk-Session-Token,
            X-Cognito-ID-Token, X-Supabase-Access-Token, or X-Omni-User-Token.
          </p>
        </section>
      )}

      <Modal
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) resetDialog();
        }}
        title="New Publishable Key"
      >
        <TextField
          label="Reference name"
          placeholder="Untitled Key"
          value={name}
          disabled={created !== null}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && created === null && !busy) void create();
          }}
        />

        {created !== null ? (
          <div className="flex flex-col gap-[8px]">
            <span className="type-strong-13 text-foreground-primary">Key generated</span>
            <div className="flex items-center gap-[6px] rounded-[var(--radius-field)] border border-solid border-border bg-input-background p-[10px]">
              <code className="min-w-0 flex-1 select-all truncate type-mono-12 text-foreground-primary">
                {created.secret}
              </code>
              <button
                type="button"
                onClick={copy}
                className="flex shrink-0 items-center gap-[4px] py-[4px] type-strong-12 text-accent-primary"
              >
                <ThemedIcon src={copyIcon} className="size-[14px]" />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="type-label-12 text-foreground-secondary">
              Copy this key now. It cannot be shown again.
            </p>
          </div>
        ) : null}

        {error !== null ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}

        <div className="-mx-[16px] -mb-[16px] flex justify-end border-t border-solid border-border p-[12px]">
          {created === null ? (
            <Button variant="primary" disabled={busy} onClick={create}>
              {busy ? "Generating…" : "Generate"}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => {
                setDialogOpen(false);
                resetDialog();
              }}
            >
              Done
            </Button>
          )}
        </div>
      </Modal>
    </>
  );
}
