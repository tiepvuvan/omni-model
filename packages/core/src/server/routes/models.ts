import type { Context } from "hono";
import type { ModelInfo, ModelList } from "../../openai/types.js";
import type { RuntimeContext } from "../../types.js";
import { redactModelInfo } from "../response.js";
import type { AppEnv } from "../types.js";
import type { RouteDeps } from "./chat.js";

/**
 * GET /v1/models — the union of every provider's model list, queried
 * concurrently. Providers without `listModels` are skipped; providers whose
 * listing fails are skipped with a warning so one broken upstream cannot hide
 * the rest. Duplicate model ids keep the first provider's entry (config
 * order).
 */
export function createModelsHandler(deps: RouteDeps): (c: Context<AppEnv>) => Promise<Response> {
  return async (c) => {
    if (deps.allowedModels.length > 0) {
      const body: ModelList = {
        object: "list",
        data: deps.allowedModels.map((id) => ({
          id,
          object: "model",
          created: 0,
          owned_by: "omni-model",
        })),
      };
      return c.json(body);
    }

    const runtime = deps.runtimeFor(c);
    const listable: { providerId: string; list: (ctx: RuntimeContext) => Promise<ModelInfo[]> }[] =
      [];
    for (const provider of deps.providers.values()) {
      const list = provider.listModels?.bind(provider);
      if (list !== undefined) listable.push({ providerId: provider.id, list });
    }

    const settled = await Promise.allSettled(listable.map((entry) => entry.list(runtime)));
    const byId = new Map<string, ModelInfo>();
    settled.forEach((result, index) => {
      if (result.status === "rejected") {
        deps.log.warn("provider listModels failed; skipping its models", {
          provider: listable[index]?.providerId,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        return;
      }
      for (const model of result.value) {
        if (!byId.has(model.id)) byId.set(model.id, redactModelInfo(model));
      }
    });

    const body: ModelList = { object: "list", data: [...byId.values()] };
    return c.json(body);
  };
}
