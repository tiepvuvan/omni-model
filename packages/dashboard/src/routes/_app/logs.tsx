import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Callout, cx, Drawer } from "../../components/ui/primitives";
import { ApiError, api, type RequestLog } from "../../lib/api";
import { pageHead } from "../../lib/page-title";

export const Route = createFileRoute("/_app/logs")({
  head: () => pageHead("Activity Logs"),
  loader: async () => {
    try {
      return { page: await api.logs(), error: null };
    } catch (error) {
      return {
        page: { logs: [], nextBefore: null },
        error: error instanceof Error ? error.message : "Request logs could not be loaded",
      };
    }
  },
  component: ActivityLogs,
});

const NUMBER = new Intl.NumberFormat();

function tokens(value: number | null): string {
  return value === null ? "—" : `${NUMBER.format(value)} tokens`;
}

function duration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1_000) return `${NUMBER.format(value)} ms`;
  return `${(value / 1_000).toFixed(2)} s`;
}

function formatClock(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function formatFullTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(value);
}

function requestTime(value: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - value);
  if (elapsed < 60_000) return `${Math.max(1, Math.floor(elapsed / 1_000))} seconds ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} minutes ago`;

  const requested = new Date(value);
  const today = new Date(now);
  if (
    requested.getFullYear() === today.getFullYear() &&
    requested.getMonth() === today.getMonth() &&
    requested.getDate() === today.getDate()
  ) {
    return `Today, ${new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(value)}`;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    value,
  );
}

function outcome(log: RequestLog): string {
  if (log.status < 400) return "Authenticated";
  if (log.status === 401 || log.status === 403) return "Rejected";
  return "Failed";
}

function clientName(log: RequestLog): string {
  return log.writeKeyName ?? log.writeKeyId ?? "Direct client";
}

function DetailSection({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        "flex flex-col gap-[12px] border-b border-solid border-border p-[20px]",
        className,
      )}
    >
      <h2 className="type-strong-14 text-foreground-primary">{title}</h2>
      {children}
    </section>
  );
}

function DetailGrid({ rows }: { rows: readonly [string, string][] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,0.7fr)_minmax(0,1.3fr)] gap-x-[20px] gap-y-[10px]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="type-label-12 text-foreground-secondary">{label}</dt>
          <dd className="min-w-0 break-words text-right type-copy-14 text-foreground-primary">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-[360px] w-full overflow-auto rounded-[var(--radius-field)] border border-solid border-border bg-background-l1 p-[12px] whitespace-pre-wrap break-words type-mono-12 text-foreground-primary">
      {pretty(value)}
    </pre>
  );
}

function PromptView({ messages }: { messages: unknown }) {
  if (!Array.isArray(messages)) return <JsonBlock value={messages} />;
  return (
    <div className="flex flex-col gap-[8px]">
      {messages.map((message, index) => {
        const row =
          typeof message === "object" && message !== null
            ? (message as Record<string, unknown>)
            : null;
        const role = typeof row?.role === "string" ? row.role : `Message ${index + 1}`;
        const messageKey = typeof row?.id === "string" ? row.id : `${role}-${pretty(message)}`;
        return (
          <div
            key={messageKey}
            className="rounded-[var(--radius-field)] border border-solid border-border bg-background-l1"
          >
            <div className="border-b border-solid border-border px-[12px] py-[8px] type-strong-12 capitalize text-foreground-secondary">
              {role}
            </div>
            <div className="p-[12px] whitespace-pre-wrap break-words type-copy-14 text-foreground-primary">
              {typeof row?.content === "string" ? row.content : pretty(row?.content ?? message)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MissingContent() {
  return (
    <p className="type-copy-14 text-foreground-secondary">
      Content was not captured for this request. Enable content capture globally or for its write
      key to retain prompts, redacted headers, and the request body.
    </p>
  );
}

function RequestDetails({ log }: { log: RequestLog }) {
  const result = outcome(log);
  const content = log.content;
  const headers = Object.entries(content?.headers ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return (
    <>
      {content?.truncated === true ? (
        <div className="p-[20px] pb-0">
          <Callout tone="warning" title="Captured content was truncated">
            The configured byte cap was reached, so prompts, headers, body, or response may be
            partial.
          </Callout>
        </div>
      ) : null}

      <DetailSection title="Overview">
        <DetailGrid
          rows={[
            ["Client", clientName(log)],
            ["Outcome", `${result} · HTTP ${log.status}`],
            ["Request time", formatFullTime(log.ts)],
            ["Request ID", log.requestId],
            ["User ID", log.userId ?? "—"],
            ["Device ID", log.deviceId ?? "—"],
            ["Auth provider", log.authProvider ?? "—"],
            ["IP address", log.ip ?? "—"],
            ["User agent", log.userAgent ?? "—"],
            ["Streaming", log.stream ? "Yes" : "No"],
            ["Response cache", log.cached ? "Hit" : "Miss"],
            ["Error code", log.errorCode ?? "—"],
            ["Rate-limit rule", log.rateLimitRule ?? "—"],
          ]}
        />
      </DetailSection>

      <DetailSection title="Routing">
        <DetailGrid
          rows={[
            ["Requested model", log.modelRequested ?? "—"],
            ["Routed model", log.modelRouted ?? "—"],
            ["Provider", log.providerId ?? "—"],
            ["Route", log.routeName ?? "—"],
          ]}
        />
      </DetailSection>

      <DetailSection title="Tokens and timing">
        <DetailGrid
          rows={[
            ["Input tokens", tokens(log.promptTokens)],
            ["Output tokens", tokens(log.completionTokens)],
            ["Total tokens", tokens(log.totalTokens)],
            ["Request latency", duration(log.latencyMs)],
            ["Time to first byte", duration(log.ttfbMs)],
          ]}
        />
      </DetailSection>

      <DetailSection title="Prompts">
        {content === undefined ? <MissingContent /> : <PromptView messages={content.messages} />}
      </DetailSection>

      <DetailSection title="Headers">
        {content === undefined ? (
          <MissingContent />
        ) : headers.length === 0 ? (
          <p className="type-copy-14 text-foreground-secondary">No headers were captured.</p>
        ) : (
          <dl className="overflow-hidden rounded-[var(--radius-field)] border border-solid border-border">
            {headers.map(([name, value]) => (
              <div
                key={name}
                className="grid grid-cols-[minmax(140px,0.8fr)_minmax(0,1.2fr)] gap-[16px] border-b border-solid border-border px-[12px] py-[8px] last:border-b-0"
              >
                <dt className="break-all type-mono-12 text-foreground-secondary">{name}</dt>
                <dd className="break-all text-right type-mono-12 text-foreground-primary">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </DetailSection>

      <DetailSection title="Request body">
        {content?.body === undefined ? <MissingContent /> : <JsonBlock value={content.body} />}
      </DetailSection>

      <DetailSection title="Response" className="border-b-0">
        {content === undefined ? (
          <MissingContent />
        ) : content.completion === null ? (
          <p className="type-copy-14 text-foreground-secondary">No completion was captured.</p>
        ) : (
          <JsonBlock value={content.completion} />
        )}
      </DetailSection>
    </>
  );
}

function ActivityLogs() {
  const { page, error } = Route.useLoaderData();
  const [selected, setSelected] = useState<RequestLog | null>(null);
  const [detail, setDetail] = useState<RequestLog | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const activeRequest = useRef<string | null>(null);

  const open = async (log: RequestLog) => {
    activeRequest.current = log.requestId;
    setSelected(log);
    setDetail(null);
    setDetailError(null);
    try {
      const loaded = await api.log(log.requestId);
      if (activeRequest.current === log.requestId) setDetail(loaded);
    } catch (loadError) {
      if (activeRequest.current !== log.requestId) return;
      setDetailError(
        loadError instanceof ApiError || loadError instanceof Error
          ? loadError.message
          : "Request details could not be loaded",
      );
    }
  };

  const close = () => {
    activeRequest.current = null;
    setSelected(null);
    setDetail(null);
    setDetailError(null);
  };

  return (
    <div className="min-h-full bg-background-l2">
      <div className="border-b border-solid border-border px-[16px] pb-[16px] pt-[24px]">
        <h1 className="type-heading-20 text-foreground-primary">Activity Logs</h1>
      </div>

      {error !== null ? (
        <div className="p-[16px]">
          <Callout tone="danger" title="Activity logs are unavailable" role="alert">
            {error}
          </Callout>
        </div>
      ) : page.logs.length === 0 ? (
        <div className="p-[24px] type-copy-14 text-foreground-secondary">
          No requests have been logged yet.
        </div>
      ) : (
        <div className="w-full overflow-x-auto">
          <table
            className="w-full min-w-[900px] table-fixed border-collapse"
            aria-label="Activity logs"
          >
            <thead>
              <tr>
                {[
                  "Client",
                  "Status",
                  "Routed model",
                  "Output tokens",
                  "Input tokens",
                  "Request time",
                ].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="border-b border-solid border-border p-[12px] text-left type-strong-14 text-foreground-primary"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.logs.map((log) => {
                const result = outcome(log);
                return (
                  <tr
                    key={log.id}
                    tabIndex={0}
                    aria-label={`Open request ${log.requestId}`}
                    onClick={() => void open(log)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void open(log);
                      }
                    }}
                    className="cursor-pointer outline-none hover:bg-item-selection focus-visible:bg-item-selection"
                  >
                    <td className="truncate border-b border-solid border-border p-[12px] type-copy-14 text-foreground-primary">
                      {clientName(log)}
                    </td>
                    <td className="border-b border-solid border-border p-[12px] type-copy-14 text-foreground-primary">
                      {result}
                    </td>
                    <td className="truncate border-b border-solid border-border p-[12px] type-copy-14 text-foreground-primary">
                      {log.modelRouted ?? "—"}
                    </td>
                    <td className="border-b border-solid border-border p-[12px] type-copy-14 text-foreground-primary">
                      {tokens(log.completionTokens)}
                    </td>
                    <td className="border-b border-solid border-border p-[12px] type-copy-14 text-foreground-primary">
                      {tokens(log.promptTokens)}
                    </td>
                    <td
                      className="border-b border-solid border-border p-[12px] type-copy-14 text-foreground-primary"
                      title={formatClock(log.ts)}
                    >
                      {requestTime(log.ts)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={selected !== null}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title="Request details"
        description={selected?.requestId}
      >
        {detailError !== null ? (
          <div className="p-[20px]">
            <Callout tone="danger" title="Request details are unavailable" role="alert">
              {detailError}
            </Callout>
          </div>
        ) : detail === null ? (
          <p className="p-[20px] type-copy-14 text-foreground-secondary">
            Loading request details…
          </p>
        ) : (
          <RequestDetails log={detail} />
        )}
      </Drawer>
    </div>
  );
}
