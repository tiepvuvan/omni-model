import { badRequest, isSecretRef, notFound, OmniError } from "@omni-model/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AdminDeps } from "../deps.js";
import { type AdminEnv, actorOf } from "../session.js";

const putSchema = z.object({
  name: z.string().min(1).max(200),
  value: z.string().min(1),
});

/** Every `$secret` id referenced anywhere in a document. */
function referencedIds(node: unknown, found: Set<string>): Set<string> {
  if (isSecretRef(node)) {
    found.add(node.$secret);
    return found;
  }
  if (Array.isArray(node)) {
    for (const item of node) referencedIds(item, found);
    return found;
  }
  if (typeof node === "object" && node !== null) {
    for (const value of Object.values(node)) referencedIds(value, found);
  }
  return found;
}

/**
 * Encrypted credentials.
 *
 * Write-only by construction: there is no route that returns a value, and this
 * module never calls `SecretStore.reveal` — that is the bundle builder's
 * privilege alone. Everything here returns a description: name, hint,
 * fingerprint, which key sealed it.
 */
export function createSecretRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  const store = () => {
    if (deps.secrets === null) {
      throw new OmniError(
        503,
        "encrypted secrets are unavailable: set OMNI_ENCRYPTION_KEY and use PostgreSQL storage",
        { type: "api_error", code: "secrets_unavailable" },
      );
    }
    return deps.secrets;
  };

  app.get("/secrets", async (c) => {
    return c.json({ secrets: await store().list() });
  });

  app.put("/secrets", async (c) => {
    const body = putSchema.parse(await c.req.json());
    const actor = actorOf(c);
    // Replacing by name keeps the id, so rotating a credential does not require
    // editing every configuration that references it.
    const description = await store().put(body.name, body.value);
    deps.logger?.info("secret stored", {
      id: description.id,
      name: description.name,
      by: actor.email,
    });
    return c.json({ secret: description });
  });

  app.delete("/secrets/:id", async (c) => {
    const id = c.req.param("id");
    const secrets = store();
    if ((await secrets.describe(id)) === null) {
      throw notFound(`secret "${id}" does not exist`);
    }

    // Deleting a referenced secret would make the *next* reload fail, long after
    // the delete looked successful. Refuse unless the caller says they mean it.
    const active = await deps.configStore.loadActive();
    if (active !== null && referencedIds(active.document, new Set()).has(id)) {
      if (c.req.query("force") !== "true") {
        throw new OmniError(
          409,
          `secret "${id}" is referenced by the active configuration; ` +
            "update the configuration first, or repeat with ?force=true",
          { code: "secret_in_use" },
        );
      }
      deps.logger?.warn("deleting a secret still referenced by the active configuration", {
        id,
        by: actorOf(c).email,
      });
    }

    const deleted = await secrets.delete(id);
    if (!deleted) throw notFound(`secret "${id}" does not exist`);
    deps.logger?.info("secret deleted", { id, by: actorOf(c).email });
    return c.json({ deleted: true });
  });

  app.post("/secrets/rotate", async (c) => {
    // Re-seals every secret under the active master key. Safe to repeat.
    const result = await store().rotate();
    deps.logger?.info("secrets re-sealed under the active key", {
      ...result,
      by: actorOf(c).email,
    });
    return c.json(result);
  });

  app.get("/secrets/:id", async (c) => {
    const description = await store().describe(c.req.param("id"));
    if (description === null) throw notFound("secret does not exist");
    return c.json({ secret: description });
  });

  app.get("/secrets/:id/value", () => {
    // Explicit, so that "why can't I read it back" has an answer rather than a 404.
    throw badRequest("secret values cannot be read back. Store a new value to replace it.", {
      code: "secrets_are_write_only",
    });
  });

  return app;
}
