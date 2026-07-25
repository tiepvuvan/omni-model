import {
  badRequest,
  notFound,
  type OmniError,
  OmniError as OmniErrorClass,
  type RuntimeContext,
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

export function createConfigRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  /** The stored document, which holds references rather than resolved values. */
  const storedDocument = async (): Promise<Record<string, unknown>> => {
    const active = await deps.configStore.loadActive();
    return isRecord(active?.document) ? { ...active.document } : {};
  };

  /**
   * Validate, persist, then apply — in that order.
   *
   * Applying before persisting would leave this replica running a configuration
   * no other replica has if the write then failed. Other replicas pick the
   * revision up through the config store's change feed.
   */
  const save = async (
    c: Context<AdminEnv>,
    document: unknown,
    note: string | undefined,
  ): Promise<Response> => {
    const check = await deps.holder.validate(document);
    if (!check.ok) throw rejected(check.error);

    const actor = actorOf(c);
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

  /** Replace one top-level block. */
  const patchBlock = (block: "security" | "rateLimits" | "routing" | "logging") => {
    app.put(`/${block === "rateLimits" ? "rate-limits" : block}`, async (c) => {
      const body = patchSchema.parse(await c.req.json());
      const document = await storedDocument();
      document[block] = body.value;
      return save(c, document, body.note ?? `update ${block}`);
    });
  };
  patchBlock("security");
  patchBlock("rateLimits");
  patchBlock("routing");
  patchBlock("logging");

  app.put("/providers/:id", async (c) => {
    const id = c.req.param("id");
    const body = patchSchema.parse(await c.req.json());
    const document = await storedDocument();
    const providers = isRecord(document.providers) ? { ...document.providers } : {};
    providers[id] = body.value;
    document.providers = providers;
    return save(c, document, body.note ?? `update provider ${id}`);
  });

  app.delete("/providers/:id", async (c) => {
    const id = c.req.param("id");
    const document = await storedDocument();
    const providers = isRecord(document.providers) ? { ...document.providers } : {};
    if (!(id in providers)) throw notFound(`provider "${id}" does not exist`);
    delete providers[id];
    document.providers = providers;
    return save(c, document, `remove provider ${id}`);
  });

  /**
   * Probe a live provider.
   *
   * Runs against the *applied* bundle rather than a candidate document, so the
   * answer is about what is actually serving traffic — which is the question an
   * operator is asking when a client reports failures.
   *
   * The verdict comes from watching the upstream call, not from whether
   * `listModels` resolved: that method deliberately falls back to the configured
   * model list on any failure, because `/v1/models` should keep working when a
   * provider has no discovery endpoint. Trusting its return value here would
   * report a rejected API key as a healthy provider.
   */
  app.post("/providers/:id/test", async (c) => {
    const id = c.req.param("id");
    const bundle = deps.holder.current();
    if (bundle === null) throw new OmniErrorClass(503, "no configuration is applied");
    const provider = bundle.providers.get(id);
    if (provider === undefined) throw notFound(`provider "${id}" is not configured`);
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
