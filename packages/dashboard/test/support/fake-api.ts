import { vi } from "vitest";
import type { ProbeResponse } from "../../src/lib/api";

/**
 * A stand-in for the admin API, wired in as `globalThis.fetch`.
 *
 * Stubbing at the network boundary rather than mocking `lib/api` is deliberate:
 * the client's own behaviour — credential mode, error unwrapping, the 401 signal
 * the route guards depend on — is part of what these tests are checking. A mocked
 * module would make every one of those a blind spot.
 *
 * The store also *behaves*: a `PUT /routing/rules/:id` upserts by id and keeps the
 * rule's position, and `PUT /routing` replaces the list wholesale, exactly as the
 * real endpoints do. That is what lets a reorder test assert on the resulting
 * order instead of on the request body.
 */

export interface FakeState {
  /** Accounts in the database; zero means first-run sign-up is open. */
  operators: number;
  /** Whether the session cookie is valid. */
  signedIn: boolean;
  config: Record<string, unknown>;
  revision: number;
  /** Set to make the next save fail, the way a rejected document does. */
  rejectSave: string | null;
  lastError: string | null;
  /** Recorded requests, for asserting what was actually sent. */
  calls: { method: string; path: string; body: unknown }[];
  /** What `POST /routing/rules/:id/test` should answer. */
  probe: ProbeResponse;
  simulate: unknown;
  /** Warnings the next save should answer with. */
  warnings: string[];
}

export const PROVIDER_SCHEMAS = [
  {
    type: "anthropic",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        apiKey: { type: "string" },
        baseUrl: { type: "string" },
        maxTokensDefault: { type: "integer", minimum: 1 },
      },
      required: ["apiKey"],
    },
  },
  {
    type: "openai-compatible",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        apiKey: { type: "string" },
        baseUrl: { type: "string" },
        headers: { type: "object" },
        models: { type: "array", items: { type: "string" } },
        includeStreamUsage: { type: "boolean" },
      },
      required: ["baseUrl"],
    },
  },
];

export const VERIFIER_SCHEMAS = [
  {
    type: "apple-app-attest",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        teamId: { type: "string" },
        bundleId: { type: "string" },
        environment: { type: "string", enum: ["production", "development"] },
      },
      required: ["teamId", "bundleId"],
    },
  },
  {
    type: "apple-device-check",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        teamId: { type: "string" },
        keyId: { type: "string" },
        privateKey: { type: "string" },
      },
      required: ["teamId", "keyId", "privateKey"],
    },
  },
  {
    type: "firebase-app-check",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        projectNumber: { type: "string" },
        appIds: { type: "array", items: { type: "string" } },
        consume: { type: "boolean", description: "Use App Check limited token" },
      },
    },
  },
  {
    type: "firebase-auth",
    optionsSchema: {
      type: "object",
      properties: { type: { type: "string" }, projectId: { type: "string" } },
      required: ["projectId"],
    },
  },
  {
    type: "jwt",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        secret: { type: "string" },
        algorithms: { type: "array", items: { type: "string" } },
        issuer: { type: "string" },
        audience: { type: "string" },
      },
    },
  },
  {
    type: "supabase",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        baseUrl: { type: "string" },
        jwksUrl: { type: "string" },
        jwtSecret: { type: "string" },
      },
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createFakeApi(initial: Partial<FakeState> = {}) {
  const state: FakeState = {
    operators: 1,
    signedIn: true,
    config: {},
    revision: 1,
    rejectSave: null,
    lastError: null,
    calls: [],
    probe: { ok: true, latencyMs: 12, models: 3 },
    simulate: { matched: false, reason: "no rule matches", rules: [], warnings: [] },
    warnings: [],
    ...initial,
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const error = (status: number, message: string, code?: string): Response =>
    json({ error: { message, type: "invalid_request_error", code: code ?? null } }, status);

  /** The routing block out of the stored document, defaulted like the real one. */
  const routing = (): { allowedModels: unknown[]; rules: Record<string, unknown>[] } => {
    const block = isRecord(state.config.routing) ? state.config.routing : {};
    return {
      allowedModels: Array.isArray(block.allowedModels) ? block.allowedModels : [],
      rules: Array.isArray(block.rules)
        ? (block.rules.filter(isRecord) as Record<string, unknown>[])
        : [],
    };
  };

  const save = (next: Record<string, unknown>): Response => {
    if (state.rejectSave !== null) return error(400, state.rejectSave, "invalid_configuration");
    state.config = next;
    state.revision += 1;
    return json({
      revision: state.revision,
      config: state.config,
      warnings: state.warnings,
    });
  };

  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "").replace("/admin/api", "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body: unknown =
      typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    state.calls.push({ method, path, body });

    if (path === "/setup") {
      return json({ needsFirstOperator: state.operators === 0, operators: state.operators });
    }

    if (path === "/auth/sign-in/email") {
      const credentials = isRecord(body) ? body : {};
      if (credentials.password === "correct horse battery staple") {
        state.signedIn = true;
        return json({ user: { id: "u1", email: credentials.email } });
      }
      return error(401, "Invalid email or password");
    }

    if (path === "/auth/sign-up/email") {
      if (state.operators > 0) return error(403, "sign-up is closed");
      state.operators += 1;
      state.signedIn = true;
      return json({ user: { id: "u1" } });
    }

    if (path === "/auth/sign-out") {
      state.signedIn = false;
      return json({ success: true });
    }

    // Everything past here needs a session, exactly like the real app.
    if (!state.signedIn) {
      return error(401, "sign in to use the admin API", "admin_unauthenticated");
    }

    switch (true) {
      case path === "/me":
        return json({ actor: { id: "u1", email: "ops@example.test", name: "Ops", role: "admin" } });

      case path === "/status":
        return json({
          configured: true,
          revision: state.revision,
          lastError: state.lastError,
          providers: routing().rules.map((rule, index) => String(rule.id ?? index)),
          verifiers: ["jwt"],
          requireWriteKey: false,
        });

      case path === "/meta":
        return json({
          providers: PROVIDER_SCHEMAS,
          authVerifiers: VERIFIER_SCHEMAS,
          storage: [{ type: "postgres", optionsSchema: null }],
          secretsAvailable: true,
          logsAvailable: true,
        });

      case path === "/config":
        return json({
          config: clone(state.config),
          revision: state.revision,
          createdAt: 0,
          createdBy: "ops@example.test",
          note: null,
          applied: true,
          appliedRevision: state.revision,
          error: state.lastError,
        });

      case path === "/routing" && method === "PUT": {
        const value = isRecord(body) && isRecord(body.value) ? body.value : {};
        return save({ ...state.config, routing: value });
      }

      case path === "/security" && method === "PUT": {
        const value = isRecord(body) && isRecord(body.value) ? body.value : {};
        return save({ ...state.config, security: value });
      }

      case path === "/routing/simulate":
        return json(state.simulate);

      case /^\/routing\/rules\/[^/]+\/test$/.test(path):
        return json(state.probe);

      case /^\/routing\/rules\/[^/]+$/.test(path) && method === "PUT": {
        const id = decodeURIComponent(path.split("/")[3] ?? "");
        const value = isRecord(body) && isRecord(body.value) ? body.value : {};
        const block = routing();
        const rule = { ...value, id };
        const at = block.rules.findIndex(
          (existing, index) => (existing.id ?? `rules[${index}]`) === id,
        );
        // Replacing keeps the position; a new rule appends. Order is meaning.
        if (at === -1) block.rules.push(rule);
        else block.rules[at] = rule;
        return save({ ...state.config, routing: block });
      }

      case /^\/routing\/rules\/[^/]+$/.test(path) && method === "DELETE": {
        const id = decodeURIComponent(path.split("/")[3] ?? "");
        const block = routing();
        const remaining = block.rules.filter(
          (rule, index) => (rule.id ?? `rules[${index}]`) !== id,
        );
        if (remaining.length === block.rules.length) {
          return error(404, `routing rule "${id}" does not exist`);
        }
        return save({ ...state.config, routing: { ...block, rules: remaining } });
      }

      default:
        return error(404, `no fake route for ${method} ${path}`);
    }
  };

  return {
    state,
    /** Install as the global `fetch`; `vi.unstubAllGlobals` undoes it. */
    install(): void {
      vi.stubGlobal("fetch", vi.fn(handler));
    },
    /** Every request to a path, for asserting what a click actually sent. */
    callsTo(method: string, path: string) {
      return state.calls.filter((call) => call.method === method && call.path === path);
    },
  };
}

export type FakeApi = ReturnType<typeof createFakeApi>;
