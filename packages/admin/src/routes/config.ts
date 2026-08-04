import {
  badRequest,
  CREDENTIAL_FIELDS,
  isSecretRef,
  notFound,
  type OmniError,
  OmniError as OmniErrorClass,
  type RuntimeContext,
  sealCredentials,
  unreachableRules,
} from "@omni-model/core";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AdminDeps } from "../deps.js";
import { type AdminEnv, actorOf } from "../session.js";

/** A configuration document plus an optional audit note. */
const saveSchema = z.object({
  config: z.unknown(),
  note: z.string().max(500).optional(),
});

const patchSchema = z.object({
  value: z.unknown(),
  note: z.string().max(500).optional(),
});

function rejected(error: string): OmniError {
  // A rejected configuration is the caller's mistake, and the message is the
  // whole value of the endpoint — it is the same text startup would have printed.
  return badRequest(error, { code: "invalid_config", param: "config" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Paths holding a plaintext credential, so a refusal can name them.
 *
 * Paths only, never values: the point of refusing is that this value must not be
 * stored, and echoing it into an error message would store it in a log instead.
 */
function findCredentialPaths(node: unknown, path = "", found: string[] = []): string[] {
  if (isSecretRef(node) || node === null || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      findCredentialPaths(item, `${path}[${index}]`, found);
    });
    return found;
  }
  for (const [field, value] of Object.entries(node)) {
    const child = path === "" ? field : `${path}.${field}`;
    // A `${VAR}` reference is resolved from the environment and was never stored.
    const isEnvReference = typeof value === "string" && /^\$\{[^}]+\}$/.test(value.trim());
    if (CREDENTIAL_FIELDS.includes(field) && typeof value === "string" && value !== "") {
      if (!isEnvReference) found.push(child);
      continue;
    }
    findCredentialPaths(value, child, found);
  }
  return found;
}

/** Read a dotted/indexed path like `providers.primary.apiKey`. */
function valueAtPath(node: unknown, path: string): unknown {
  let current: unknown = node;
  for (const step of path.split(".")) {
    const match = /^([^[]*)((?:\[\d+\])*)$/.exec(step);
    if (match === null) return undefined;
    const [, field, indexes] = match;
    if (field !== undefined && field !== "") {
      if (!isRecord(current)) return undefined;
      current = current[field];
    }
    for (const [, index] of (indexes ?? "").matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(current) || index === undefined) return undefined;
      current = current[Number(index)];
    }
  }
  return current;
}

/** Human-readable warnings about a rule list that is valid but self-defeating. */
function routingWarnings(
  rules: ReadonlyArray<{ when: string; id?: string | undefined; name?: string | undefined }>,
): string[] {
  return unreachableRules(rules).map(
    ({ rule, shadowedBy }) =>
      `rule "${rule}" can never match: "${shadowedBy}" earlier in the list matches everything ` +
      `(when: "true"). Move "${rule}" above it — rules are evaluated in order and the first match wins.`,
  );
}

export function createConfigRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  /** The stored document, which holds references rather than resolved values. */
  const storedDocument = async (): Promise<Record<string, unknown>> => {
    const active = await deps.configStore.loadActive();
    return isRecord(active?.document) ? { ...active.document } : {};
  };

  /**
   * Turn any plaintext credential in an inbound document into a reference.
   *
   * The dashboard types an API key into a named provider, so this is the
   * boundary where that value stops being plaintext. Existing references pass
   * through untouched, so reading a configuration and saving it back does not
   * mint a secret per save.
   */
  const sealInbound = async (c: Context<AdminEnv>, document: unknown): Promise<unknown> => {
    if (deps.secrets === null) {
      // Without a keyring there is nowhere to put a credential, and storing it
      // inline would break the guarantee that a revision never holds one.
      //
      // Only *new* plaintext is refused, though. A deployment configured from the
      // environment has plaintext in its seeded revision already, and every
      // block-level write reads that document back — so refusing on its mere
      // presence would make an unrelated change (logging, a rate limit) impossible
      // to save. What matters is that this request does not introduce one.
      const stored = await storedDocument();
      const introduced = findCredentialPaths(document).filter(
        (path) => valueAtPath(document, path) !== valueAtPath(stored, path),
      );
      if (introduced.length === 0) return document;
      throw badRequest(
        `this configuration introduces credentials (${introduced.join(", ")}) but encrypted ` +
          "storage is unavailable: set OMNI_ENCRYPTION_KEY so they can be sealed, or replace them " +
          "with ${VAR} references resolved from the environment",
        { code: "secrets_unavailable" },
      );
    }
    const result = await sealCredentials(document, deps.secrets);
    if (result.sealed.length > 0) {
      // Paths only. A log line must never carry the value that was just sealed.
      deps.logger?.info("sealed credentials from an admin write", {
        paths: result.sealed,
        by: actorOf(c).email,
      });
    }
    return result.document;
  };

  /**
   * Seal, validate, persist, then apply — in that order.
   *
   * Sealing comes first because it is what the *stored* document must contain: a
   * dashboard sends an API key as plaintext, and the revision may only ever hold
   * a reference to it. Validation then runs on the sealed document, which is the
   * one that will be replayed on every future boot — validating the plaintext
   * instead would pass here and fail later if the reference could not resolve.
   *
   * Applying before persisting would leave this replica running a configuration
   * no other replica has if the write then failed. Other replicas pick the
   * revision up through the config store's change feed.
   */
  const save = async (
    c: Context<AdminEnv>,
    input: unknown,
    note: string | undefined,
  ): Promise<Response> => {
    const actor = actorOf(c);
    const document = await sealInbound(c, input);

    const check = await deps.holder.validate(document);
    if (!check.ok) throw rejected(check.error);

    const saved = await deps.configStore.save(document, {
      createdBy: actor.email,
      ...(note === undefined ? {} : { note }),
    });
    const applied = await deps.holder.reload(saved.document, { revision: saved.revision });
    deps.logger?.info("configuration saved through the admin API", {
      revision: saved.revision,
      by: actor.email,
      applied: applied.ok,
    });
    return c.json({
      revision: saved.revision,
      createdAt: saved.createdAt,
      createdBy: saved.createdBy,
      note: saved.note,
      config: saved.document,
      // Valid but probably not what was meant. Adding a rule to a list that ends
      // in a catch-all appends it *after* that catch-all, where it can never fire
      // — and the proxy keeps answering normally from the earlier rule, so
      // nothing else would tell them.
      warnings: routingWarnings(deps.holder.current()?.config.routing.rules ?? []),
    });
  };

  app.get("/config", async (c) => {
    const active = await deps.configStore.loadActive();
    const status = deps.holder.status();
    return c.json({
      // Never `bundle.config`: that one has secrets and ${VAR} references
      // resolved into plaintext.
      config: active?.document ?? null,
      revision: active?.revision ?? null,
      createdAt: active?.createdAt ?? null,
      createdBy: active?.createdBy ?? null,
      note: active?.note ?? null,
      applied: status.configured,
      appliedRevision: status.revision,
      error: status.lastError,
    });
  });

  app.put("/config", async (c) => {
    const body = saveSchema.parse(await c.req.json());
    return save(c, body.config, body.note);
  });

  app.post("/config/validate", async (c) => {
    const body = saveSchema.parse(await c.req.json());
    const result = await deps.holder.validate(body.config);
    // 200 either way: "would this work" is a successful question to ask.
    return c.json(result.ok ? { valid: true } : { valid: false, error: result.error });
  });

  app.get("/config/revisions", async (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json({
      revisions: await deps.configStore.history(Number.isFinite(limit) ? limit : 50),
    });
  });

  app.get("/config/revisions/:revision", async (c) => {
    const revision = Number(c.req.param("revision"));
    if (!Number.isInteger(revision)) throw badRequest("revision must be an integer");
    const stored = await deps.configStore.get(revision);
    if (stored === null) throw notFound(`revision ${revision} does not exist`);
    return c.json(stored);
  });

  app.post("/config/revisions/:revision/rollback", async (c) => {
    const revision = Number(c.req.param("revision"));
    if (!Number.isInteger(revision)) throw badRequest("revision must be an integer");
    const stored = await deps.configStore.get(revision);
    if (stored === null) throw notFound(`revision ${revision} does not exist`);
    // A rollback is a *new* revision copying an old document, so history is
    // append-only and an audit trail can never be rewritten.
    return save(c, stored.document, `rollback to revision ${revision}`);
  });

  /**
   * Replace several top-level blocks in one revision.
   *
   * A screen that edits two blocks — rate limits and the in-flight bound live in
   * different ones — would otherwise have to send two requests, which is two
   * revisions for one Save and leaves the first applied if the second fails.
   * Read-modify-write on the server, so it cannot clobber a block it was not given.
   */
  app.patch("/config", async (c) => {
    const body = patchSchema.parse(await c.req.json());
    if (!isRecord(body.value)) throw badRequest("value must be an object of blocks");
    const document = await storedDocument();
    for (const [block, value] of Object.entries(body.value)) document[block] = value;
    return save(c, document, body.note ?? `update ${Object.keys(body.value).join(", ")}`);
  });

  /** Replace one top-level block. */
  const patchBlock = (
    block:
      | "security"
      | "providers"
      | "rateLimits"
      | "routing"
      | "logging"
      | "cache"
      | "concurrency",
  ) => {
    app.put(`/${block === "rateLimits" ? "rate-limits" : block}`, async (c) => {
      const body = patchSchema.parse(await c.req.json());
      const document = await storedDocument();
      document[block] = body.value;
      return save(c, document, body.note ?? `update ${block}`);
    });
  };
  patchBlock("security");
  patchBlock("providers");
  patchBlock("rateLimits");
  patchBlock("routing");
  patchBlock("logging");
  patchBlock("cache");
  patchBlock("concurrency");

  /** The rules array out of the stored document, as raw JSON. */
  const storedRules = async (): Promise<{
    document: Record<string, unknown>;
    routing: Record<string, unknown>;
    rules: Record<string, unknown>[];
  }> => {
    const document = await storedDocument();
    const routing = isRecord(document.routing) ? { ...document.routing } : {};
    const rules = Array.isArray(routing.rules) ? [...(routing.rules as unknown[])] : [];
    return { document, routing, rules: rules.filter(isRecord).map((rule) => ({ ...rule })) };
  };

  const ruleIdOf = (rule: Record<string, unknown>, index: number): string =>
    typeof rule.id === "string" ? rule.id : `rules[${index}]`;

  /**
   * Insert or replace one rule, matched by its id.
   *
   * Order is meaning here — the first matching rule wins — so a replacement keeps
   * its position and a new rule is appended. Reordering is `PUT /routing` with
   * the whole list, which is the only operation that can express it.
   */
  app.put("/routing/rules/:id", async (c) => {
    const id = c.req.param("id");
    const body = patchSchema.parse(await c.req.json());
    if (!isRecord(body.value)) throw badRequest("a rule must be an object", { param: "value" });

    const { document, routing, rules } = await storedRules();
    const rule = { ...body.value, id };
    const at = rules.findIndex((existing, index) => ruleIdOf(existing, index) === id);
    if (at === -1) rules.push(rule);
    else rules[at] = rule;

    routing.rules = rules;
    document.routing = routing;
    return save(c, document, body.note ?? `${at === -1 ? "add" : "update"} routing rule ${id}`);
  });

  app.delete("/routing/rules/:id", async (c) => {
    const id = c.req.param("id");
    const { document, routing, rules } = await storedRules();
    const remaining = rules.filter((rule, index) => ruleIdOf(rule, index) !== id);
    if (remaining.length === rules.length) throw notFound(`routing rule "${id}" does not exist`);

    routing.rules = remaining;
    document.routing = routing;
    return save(c, document, `remove routing rule ${id}`);
  });

  /**
   * Probe the named upstream one rule points at.
   *
   * Runs against the *applied* bundle rather than a candidate document, so the
   * answer is about what is actually serving traffic — which is the question an
   * operator is asking when a client reports failures. Addressed by rule because
   * that is the behavior being diagnosed, even though credentials are centralized
   * on named providers and several rules can share one upstream.
   *
   * The verdict comes from watching the upstream call, not from whether
   * `listModels` resolved: that method deliberately falls back to the configured
   * model list on any failure, because a provider need not have a discovery
   * endpoint. Trusting its return value would report a rejected API key as a
   * healthy upstream.
   */
  app.post("/routing/rules/:id/test", async (c) => {
    const id = c.req.param("id");
    const bundle = deps.holder.current();
    if (bundle === null) throw new OmniErrorClass(503, "no configuration is applied");

    const rule = bundle.config.routing.rules.find(
      (entry, index) => (entry.id ?? `rules[${index}]`) === id,
    );
    if (rule === undefined) throw notFound(`routing rule "${id}" is not configured`);
    // Resolved through the applied configuration, so the probe uses the same
    // decrypted credential a request would. Legacy inline targets remain keyed
    // by rule id until the operator migrates them.
    const providerId = typeof rule.target.provider === "string" ? rule.target.provider : id;
    const provider = bundle.providers.get(providerId);
    if (provider === undefined) throw notFound(`routing rule "${id}" is not configured`);
    if (provider.listModels === undefined) {
      return c.json({ ok: null, reason: "this provider type cannot be probed" });
    }

    let upstream: { ok: boolean; status?: number; error?: string } | null = null;
    const observed: RuntimeContext = {
      ...deps.runtime,
      fetch: async (...args: Parameters<typeof fetch>) => {
        try {
          const response = await deps.runtime.fetch(...args);
          // Only the first call decides: a provider that retries should not be
          // able to turn a 401 into a pass.
          upstream ??= { ok: response.ok, status: response.status };
          return response;
        } catch (error) {
          upstream ??= { ok: false, error: error instanceof Error ? error.message : String(error) };
          throw error;
        }
      },
    };

    const started = deps.runtime.now();
    let models = 0;
    try {
      models = (await provider.listModels(observed)).length;
    } catch (error) {
      upstream ??= { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const latencyMs = deps.runtime.now() - started;

    if (upstream === null) {
      // It answered from configuration without contacting anything, so there is
      // nothing to report about the upstream.
      return c.json({
        ok: null,
        latencyMs,
        models,
        reason: "this provider does not contact the upstream to list models",
      });
    }
    // Always 200: "the upstream is refusing us" is a successful answer to "is
    // the upstream reachable".
    return c.json({
      ok: upstream.ok,
      latencyMs,
      models,
      status: upstream.status ?? null,
      error: upstream.error ?? null,
    });
  });

  return app;
}
