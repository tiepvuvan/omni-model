import { badRequest, type PromptCache } from "@omni-model/core";
import { Hono } from "hono";
import type { AdminDeps } from "../deps.js";
import { type AdminEnv, actorOf } from "../session.js";

/**
 * The response cache: what is in it, and a way to empty it.
 *
 * Two endpoints, because those are the two questions an operator has. Whether
 * caching is *on* is configuration, so it is edited through `PUT /config` like
 * everything else — this is only the part that cannot be expressed as a document.
 */
export function createCacheRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  const store = (): PromptCache => {
    if (deps.promptCache === null) {
      throw badRequest("this deployment has no response cache: it needs PostgreSQL storage.", {
        code: "cache_unavailable",
      });
    }
    return deps.promptCache;
  };

  app.get("/cache", async (c) => {
    const config = deps.holder.current()?.config.cache ?? null;
    return c.json({
      available: deps.promptCache !== null,
      // The applied configuration, so the screen can say "on, and here is what is
      // actually in it" without the operator cross-referencing two places.
      enabled: config?.enabled ?? false,
      ttl: config?.ttl ?? null,
      maxEntries: config?.maxEntries ?? null,
      maxBytes: config?.maxBytes ?? null,
      ...(deps.promptCache === null
        ? { entries: 0, oldestAt: null, bytes: null }
        : await deps.promptCache.stats()),
    });
  });

  app.delete("/cache", async (c) => {
    const purged = await store().purge();
    // Worth an audit line: purging is invisible afterwards — the evidence is
    // exactly the rows that are no longer there.
    deps.logger?.info("purged the response cache", {
      entries: purged,
      by: actorOf(c).email,
    });
    return c.json({ purged });
  });

  return app;
}
