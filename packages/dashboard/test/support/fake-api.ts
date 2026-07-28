import { vi } from "vitest";
import type {
  ProbeResponse,
  PublishableKey,
  RequestLog,
  TeamInvite,
  TeamUser,
} from "../../src/lib/api";

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
  /** What `POST /config/validate` should answer; `null` means the document is fine. */
  validateError: string | null;
  lastError: string | null;
  /** Recorded requests, for asserting what was actually sent. */
  calls: { method: string; path: string; body: unknown }[];
  /** What `POST /routing/rules/:id/test` should answer. */
  probe: ProbeResponse;
  simulate: unknown;
  /** Warnings the next save should answer with. */
  warnings: string[];
  /** Entries the response cache reports, and whether it exists at all. */
  cache: { available: boolean; entries: number; oldestAt: number | null; bytes: number | null };
  /** Request metadata and content returned by the log endpoints. */
  logs: RequestLog[];
  /** Publishable-key descriptions; plaintext is never retained here. */
  writeKeys: PublishableKey[];
  /** Dashboard accounts. */
  users: TeamUser[];
  /** Pending dashboard invitations. */
  invites: TeamInvite[];
  /** What `POST /providers/models` should answer for a candidate target. */
  upstreamModels: {
    ok: boolean | null;
    models: string[];
    status?: number | null;
    error?: string | null;
    reason?: string;
  };
}

export const PROVIDER_SCHEMAS = [
  {
    type: "deepseek",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        apiKey: { type: "string" },
        baseUrl: { type: "string", default: "https://api.deepseek.com" },
        headers: { type: "object" },
        models: { type: "array", items: { type: "string" } },
        includeStreamUsage: { type: "boolean" },
      },
      required: ["apiKey"],
    },
  },
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

/** Verifier descriptors carry the layer, exactly as `GET /meta` does. */
export const VERIFIER_SCHEMAS = [
  {
    type: "clerk",
    layer: "user",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        issuer: { type: "string" },
        jwksUrl: { type: "string" },
        authorizedParties: { type: "array", items: { type: "string" } },
        audience: { type: "string" },
        allowPendingSessions: { type: "boolean", default: false },
        header: { type: "string", default: "x-clerk-session-token" },
        scheme: { type: "string", enum: ["bearer", "none"], default: "none" },
        clockToleranceSeconds: { type: "integer" },
      },
      required: ["issuer"],
    },
  },
  {
    type: "aws-cognito",
    layer: "user",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        region: { type: "string" },
        userPoolId: { type: "string" },
        clientIds: { type: "array", items: { type: "string" } },
        tokenUse: { type: "string", enum: ["access", "id", "either"], default: "access" },
        requiredScopes: { type: "array", items: { type: "string" } },
        header: { type: "string", default: "x-cognito-id-token" },
        scheme: { type: "string", enum: ["bearer", "none"], default: "none" },
        clockToleranceSeconds: { type: "integer" },
      },
      required: ["region", "userPoolId", "clientIds"],
    },
  },
  {
    type: "cloudflare-turnstile",
    layer: "app",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        secret: { type: "string" },
        header: { type: "string" },
        action: { type: "string" },
        hostnames: { type: "array", items: { type: "string" } },
      },
      required: ["secret"],
    },
  },
  {
    type: "google-play-integrity",
    layer: "app",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        packageName: { type: "string" },
        serviceAccountKey: { type: "string" },
        header: { type: "string" },
        maxAge: { type: "string" },
        clockToleranceSeconds: { type: "integer" },
        deviceRecognitionVerdicts: { type: "array", items: { type: "string" } },
        requireLicensed: { type: "boolean" },
        certificateSha256Digests: { type: "array", items: { type: "string" } },
      },
      required: ["packageName"],
    },
  },
  {
    type: "recaptcha-enterprise",
    layer: "app",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        projectId: { type: "string" },
        siteKey: { type: "string" },
        apiKey: { type: "string" },
        serviceAccountKey: { type: "string" },
        expectedAction: { type: "string" },
        minScore: { type: "number" },
        header: { type: "string" },
        hostnames: { type: "array", items: { type: "string" } },
        androidPackageNames: { type: "array", items: { type: "string" } },
        iosBundleIds: { type: "array", items: { type: "string" } },
      },
      required: ["projectId", "siteKey", "expectedAction", "minScore"],
    },
  },
  {
    type: "apple-app-attest",
    layer: "app",
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
    layer: "app",
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
    layer: "app",
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
    layer: "user",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        projectId: { type: "string" },
        header: { type: "string", default: "x-firebase-id-token" },
        scheme: { type: "string", enum: ["bearer", "none"], default: "none" },
      },
      required: ["projectId"],
    },
  },
  {
    type: "jwt",
    layer: "user",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        secret: { type: "string" },
        algorithms: { type: "array", items: { type: "string" } },
        issuer: { type: "string" },
        audience: { type: "string" },
        header: { type: "string", default: "x-omni-user-token" },
        scheme: { type: "string", enum: ["bearer", "none"], default: "none" },
      },
    },
  },
  {
    type: "supabase",
    layer: "user",
    optionsSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        baseUrl: { type: "string" },
        jwksUrl: { type: "string" },
        jwtSecret: { type: "string" },
        header: { type: "string", default: "x-supabase-access-token" },
        scheme: { type: "string", enum: ["bearer", "none"], default: "none" },
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
    validateError: null,
    lastError: null,
    calls: [],
    probe: { ok: true, latencyMs: 12, models: 3 },
    simulate: { matched: false, reason: "no rule matches", rules: [], warnings: [] },
    warnings: [],
    upstreamModels: { ok: true, models: ["gpt-4o", "gpt-4o-mini", "o3"] },
    cache: { available: true, entries: 0, oldestAt: null, bytes: null },
    logs: [],
    writeKeys: [],
    users: [
      {
        id: "u1",
        email: "ops@example.test",
        name: "Ops",
        role: "admin",
        createdAt: 1_700_000_000_000,
      },
    ],
    invites: [],
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

    const inviteMatch = path.match(/^\/invites\/([^/]+)$/);
    if (inviteMatch !== null && method === "GET") {
      const token = decodeURIComponent(inviteMatch[1] ?? "");
      const invite = state.invites.find(
        (candidate) => candidate.id === token.replace("token-", ""),
      );
      return invite === undefined
        ? error(404, "this invitation is invalid, expired, or has already been used")
        : json({ invite: { email: invite.email, expiresAt: invite.expiresAt } });
    }

    const acceptMatch = path.match(/^\/invites\/([^/]+)\/accept$/);
    if (acceptMatch !== null && method === "POST") {
      const token = decodeURIComponent(acceptMatch[1] ?? "");
      const at = state.invites.findIndex(
        (candidate) => candidate.id === token.replace("token-", ""),
      );
      if (at === -1) {
        return error(404, "this invitation is invalid, expired, or has already been used");
      }
      const invite = state.invites[at] as TeamInvite;
      state.users.push({
        id: `user-${state.users.length + 1}`,
        email: invite.email,
        name: isRecord(body) && typeof body.name === "string" ? body.name : invite.email,
        role: "admin",
        createdAt: Date.now(),
      });
      state.invites.splice(at, 1);
      return json({ email: invite.email });
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
          organizationName:
            isRecord(state.config.server) &&
            typeof state.config.server.organizationName === "string"
              ? state.config.server.organizationName
              : null,
          customDomain:
            isRecord(state.config.server) && typeof state.config.server.customDomain === "string"
              ? state.config.server.customDomain
              : null,
        });

      case path === "/meta":
        return json({
          providers: PROVIDER_SCHEMAS,
          authVerifiers: VERIFIER_SCHEMAS,
          storage: [{ type: "postgres", optionsSchema: null }],
          secretsAvailable: true,
          logsAvailable: true,
        });

      case path.startsWith("/logs?") && method === "GET":
        return json({
          logs: state.logs.map(({ content: _content, ...log }) => log),
          nextBefore: null,
        });

      case /^\/logs\/[^?]+\?includeContent=true$/.test(path) && method === "GET": {
        const requestId = decodeURIComponent(
          (path.match(/^\/logs\/([^?]+)/)?.[1] ?? "").replace(/\+/g, " "),
        );
        const log = state.logs.find((entry) => entry.requestId === requestId);
        return log === undefined
          ? error(404, `no request logged with id "${requestId}"`)
          : json({ log });
      }

      case path === "/write-keys" && method === "GET":
        return json({ writeKeys: clone(state.writeKeys) });

      case path === "/users" && method === "GET":
        return json({ users: clone(state.users), invites: clone(state.invites) });

      case path === "/users/invites" && method === "POST": {
        const email = isRecord(body) && typeof body.email === "string" ? body.email : "";
        if (email.trim() === "") return error(400, "email is required", "invalid_body");
        const id = `invite-${state.invites.length + 1}`;
        const invite: TeamInvite = {
          id,
          email: email.trim().toLowerCase(),
          invitedBy: "ops@example.test",
          createdAt: 1_700_000_000_000,
          expiresAt: 1_700_604_800_000,
        };
        state.invites.push(invite);
        return json(
          { invite, link: `http://admin.test/admin/accept-invite?token=token-${id}` },
          201,
        );
      }

      case /^\/users\/invites\/[^/]+$/.test(path) && method === "DELETE": {
        const id = decodeURIComponent(path.split("/")[3] ?? "");
        const at = state.invites.findIndex((invite) => invite.id === id);
        if (at === -1) return error(404, "that invitation does not exist");
        state.invites.splice(at, 1);
        return json({ revoked: true });
      }

      case path === "/write-keys" && method === "POST": {
        const referenceName = isRecord(body) && typeof body.name === "string" ? body.name : "";
        if (referenceName.trim() === "") return error(400, "name is required", "invalid_body");
        const id = `key-${state.writeKeys.length + 1}`;
        const writeKey: PublishableKey = {
          id,
          name: referenceName,
          prefix: "omk_test",
          last4: "test",
          allowedModels: null,
          captureContent: null,
          metadata: {},
          createdBy: "ops@example.test",
          createdAt: 1_700_000_000_000 + state.writeKeys.length,
          expiresAt: null,
          disabledAt: null,
          usage: { totalTokens: 0, lastUsedAt: null, lastModel: null },
        };
        state.writeKeys.push(writeKey);
        const { usage: _usage, ...description } = writeKey;
        return json({ writeKey: description, secret: `omk_test_secret_${id}` }, 201);
      }

      case /^\/write-keys\/[^/]+$/.test(path) && method === "DELETE": {
        const id = decodeURIComponent(path.split("/")[2] ?? "");
        const writeKey = state.writeKeys.find((candidate) => candidate.id === id);
        if (writeKey === undefined) return error(404, `write key "${id}" does not exist`);
        if (writeKey.disabledAt !== null) {
          return json({ revoked: false, alreadyRevoked: true });
        }
        writeKey.disabledAt = 1_700_000_001_000;
        return json({ revoked: true });
      }

      // Method-qualified: an unqualified `/config` case would swallow the PATCH
      // below and answer a save with a config payload.
      case path === "/config" && method === "GET":
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

      case path === "/config" && method === "PATCH": {
        // The real endpoint reads the stored document and replaces only the blocks
        // it was given, so the fake has to as well — otherwise a test could not
        // catch a screen that clobbers a block it does not own.
        const value = isRecord(body) && isRecord(body.value) ? body.value : {};
        return save({ ...state.config, ...value });
      }

      case path === "/cache" && method === "GET": {
        const cacheBlock = isRecord(state.config.cache) ? state.config.cache : {};
        return json({
          ...state.cache,
          enabled: cacheBlock.enabled === true,
          ttl: typeof cacheBlock.ttl === "string" ? cacheBlock.ttl : null,
          maxEntries: typeof cacheBlock.maxEntries === "number" ? cacheBlock.maxEntries : null,
          maxBytes: typeof cacheBlock.maxBytes === "number" ? cacheBlock.maxBytes : null,
        });
      }

      case path === "/cache" && method === "DELETE": {
        const purged = state.cache.entries;
        state.cache = { ...state.cache, entries: 0, bytes: 0, oldestAt: null };
        return json({ purged });
      }

      case path === "/rate-limits" && method === "PUT": {
        // An array, not an object: `rateLimits` is the one top-level block that is
        // a list, and a `{}` fallback here would silently store the wrong shape.
        const value = isRecord(body) && Array.isArray(body.value) ? body.value : [];
        return save({ ...state.config, rateLimits: value });
      }

      case path === "/config/validate" && method === "POST":
        return json(
          state.validateError === null
            ? { valid: true }
            : { valid: false, error: state.validateError },
        );

      case path === "/providers/models" && method === "POST":
        return json(state.upstreamModels);

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
