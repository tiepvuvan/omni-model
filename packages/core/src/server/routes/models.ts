import type { Context } from "hono";
import type { ModelList } from "../../openai/types.js";
import { writeKeyAllowsModel } from "../../writekeys/types.js";
import type { AppEnv } from "../types.js";
import type { RouteDeps } from "./chat.js";

/**
 * GET /v1/models — what a client may ask for.
 *
 * Deliberately *not* the upstreams' catalogues. A rule matches a client-facing
 * name and may forward a different model entirely (`request.model == "smart"` →
 * `gpt-4o-mini`), so listing what the upstream hosts would advertise names the
 * proxy does not answer to and omit the ones it does.
 *
 * The listing is therefore: `routing.allowedModels` when set — that is exactly
 * the client-facing surface — otherwise the distinct models the rules forward to,
 * which is the closest honest answer. A deployment whose rules match on patterns
 * rather than exact names cannot be enumerated, and that is what `allowedModels`
 * is for.
 */
export function createModelsHandler(deps: RouteDeps): (c: Context<AppEnv>) => Promise<Response> {
  return async (c) => {
    // From the bundle, not a captured value: `allowedModels` is enforced here
    // *and* inside the router, and the two must never disagree about what exists.
    const bundle = deps.requireBundle();
    // A write key's own allowlist narrows the listing as well as the gate, so a
    // client is never told about a model that would 404 for it.
    const writeKey = c.get("writeKey") ?? null;
    const visible = (models: readonly string[]): string[] =>
      models.filter((id) => writeKey === null || writeKeyAllowsModel(writeKey, id));

    const advertised =
      bundle.allowedModels.length > 0
        ? bundle.allowedModels
        : [
            ...new Set(
              bundle.config.routing.rules
                .map((rule) => rule.target.model)
                .filter((model): model is string => model !== undefined),
            ),
          ];

    const body: ModelList = {
      object: "list",
      data: visible(advertised).map((id) => ({
        id,
        object: "model",
        created: 0,
        // The proxy owns the client-facing name, whatever it forwards to.
        owned_by: "omni-model",
      })),
    };
    return c.json(body);
  };
}
