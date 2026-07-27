import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ActionBar, CenteredPane, PaneTitle } from "../../components/chrome";
import { AmountField } from "../../components/ratelimit/budget-card";
import { Button, Callout, Card, SelectField, Switch } from "../../components/ui/primitives";
import {
  api,
  type CacheBlock,
  type CacheState,
  type ConfigResponse,
  type ServerBlock,
} from "../../lib/api";

export const Route = createFileRoute("/_app/settings")({
  loader: async (): Promise<{ config: ConfigResponse; cache: CacheState }> => {
    const [config, cache] = await Promise.all([api.config(), api.cache()]);
    return { config, cache };
  },
  component: SettingsScreen,
});

/**
 * Core's cache defaults, mirrored for the same reason the rate-limit ones are: an
 * absent block is not an absent feature, and the screen has to show what the proxy
 * would actually do. `cache-defaults.test.ts` fails if core changes them.
 */
export const CACHE_DEFAULTS: CacheBlock = { enabled: true, ttl: "5m", maxEntries: 10_000 };

/** Core's provider-neutral per-request input-token default. */
export const SERVER_DEFAULTS: Pick<ServerBlock, "maxInputTokens"> = {
  maxInputTokens: 128_000,
};

/** The TTLs the select offers. Any duration the parser accepts still round-trips. */
const TTLS: readonly { value: string; label: string }[] = [
  { value: "5m", label: "5 minutes" },
  { value: "15m", label: "15 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "6h", label: "6 hours" },
  { value: "1d", label: "1 day" },
  { value: "7d", label: "1 week" },
];

function cacheOf(config: ConfigResponse): CacheBlock {
  const stored = config.config?.cache;
  return {
    enabled: stored?.enabled ?? CACHE_DEFAULTS.enabled,
    ttl: stored?.ttl ?? CACHE_DEFAULTS.ttl,
    maxEntries: stored?.maxEntries ?? CACHE_DEFAULTS.maxEntries,
  };
}

function serverOf(config: ConfigResponse): ServerBlock {
  return {
    ...config.config?.server,
    maxInputTokens: config.config?.server?.maxInputTokens ?? SERVER_DEFAULTS.maxInputTokens,
  };
}

const bytes = (value: number | null): string => {
  if (value === null) return "unknown size";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Settings.
 *
 * Not from a Figma node — the sidebar has the entry but the file has no screen for
 * it — so it is built from the same primitives the drawn screens use and is the
 * first thing to redraw when a design lands.
 */
function SettingsScreen() {
  const { config, cache } = Route.useLoaderData();
  const router = useRouter();
  const storedCache = cacheOf(config);
  const storedServer = serverOf(config);

  const [cacheDraft, setCacheDraft] = useState<CacheBlock>(storedCache);
  const [serverDraft, setServerDraft] = useState<ServerBlock>(storedServer);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [purged, setPurged] = useState<number | null>(null);

  const dirty =
    JSON.stringify(cacheDraft) !== JSON.stringify(storedCache) ||
    JSON.stringify(serverDraft) !== JSON.stringify(storedServer);
  const ttls = TTLS.some((option) => option.value === cacheDraft.ttl)
    ? TTLS
    : [...TTLS, { value: cacheDraft.ttl, label: cacheDraft.ttl }];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.patchConfig(
        { cache: cacheDraft, server: serverDraft },
        "update request limits and response caching",
      );
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const purge = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.purgeCache();
      setPurged(result.purged);
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The cache could not be purged.");
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
          setCacheDraft(storedCache);
          setServerDraft(storedServer);
        }}
        onSave={save}
      />

      <CenteredPane>
        <PaneTitle>Settings</PaneTitle>

        {error !== null ? (
          <Callout tone="danger" title="The change was rejected" role="alert">
            <p className="mt-[4px]">{error}</p>
          </Callout>
        ) : null}

        {!cache.available ? (
          <Callout tone="warning" role="status">
            This deployment has nowhere to cache: responses are stored in the database, and this
            instance is running on in-memory storage. Nothing here will take effect until it is
            pointed at PostgreSQL.
          </Callout>
        ) : null}

        <Card title="Request limits">
          <AmountField
            id="server-max-input-tokens"
            label="Maximum input tokens per request"
            help="Requests over this provider-neutral estimate are rejected before routing. Tokenizers differ by model, so the proxy estimates four ASCII characters per token and counts each non-ASCII code point as one; upstream-reported usage remains authoritative for billing."
            value={serverDraft.maxInputTokens}
            onChange={(maxInputTokens) => setServerDraft((now) => ({ ...now, maxInputTokens }))}
          />
          <p className="type-label-12 text-foreground-secondary">
            The default is 128,000 tokens. This limit applies to both chat completions and
            embeddings, including the complete JSON request body.
          </p>
        </Card>

        <Card title="Response cache">
          <Switch
            label="Answer an identical request from the cache"
            checked={cacheDraft.enabled}
            onCheckedChange={(enabled) => setCacheDraft((now) => ({ ...now, enabled }))}
            help="A request matches only when the resolved upstream, the resolved model and the whole request body are identical — so a hit is a request that would have produced the same answer. On by default, with a short window: a duplicate request is the cheapest saving there is."
          />

          <SelectField
            label="Keep an answer for"
            value={cacheDraft.ttl}
            items={ttls}
            onValueChange={(ttl) => setCacheDraft((now) => ({ ...now, ttl }))}
            help="How long an entry stays servable. Long enough to be worth having, short enough that a change upstream is not masked for days."
          />

          <AmountField
            id="cache-max-entries"
            label="Entries to keep"
            help="Enforced by a periodic sweep, oldest first — a budget rather than a hard ceiling, so a burst can overshoot until the next sweep."
            value={cacheDraft.maxEntries}
            onChange={(maxEntries) => setCacheDraft((now) => ({ ...now, maxEntries }))}
          />

          <p className="type-label-12 text-foreground-secondary">
            A hit costs no upstream tokens, so it is not charged to a rate limit, and the response
            carries <span className="type-mono-12">x-omni-cache: hit</span> so a client can tell.
            Requests are matched on the whole body, which includes OpenAI's{" "}
            <span className="type-mono-12">user</span> field — send it and the cache is per user;
            omit it and one user's answer can be served to another for the same prompt.
          </p>
        </Card>

        <Card
          title="What is cached now"
          footer={
            <Button onClick={purge} disabled={busy || cache.entries === 0}>
              Purge everything
            </Button>
          }
        >
          <p className="type-copy-14 text-foreground-primary">
            {cache.entries === 0
              ? "Nothing is cached."
              : `${cache.entries.toLocaleString("en-US")} ${
                  cache.entries === 1 ? "entry" : "entries"
                }, ${bytes(cache.bytes)}${
                  cache.oldestAt === null
                    ? ""
                    : `, oldest from ${new Date(cache.oldestAt).toLocaleString()}`
                }.`}
          </p>
          {purged !== null ? (
            <p className="type-label-12 text-success" role="status">
              Purged {purged.toLocaleString("en-US")} {purged === 1 ? "entry" : "entries"}.
            </p>
          ) : null}
          <p className="type-label-12 text-foreground-secondary">
            Purging is immediate and shared by every replica. The next identical request pays for a
            fresh answer.
          </p>
        </Card>
      </CenteredPane>
    </>
  );
}
