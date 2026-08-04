/**
 * The one place the dashboard talks to the admin API.
 *
 * Every call goes through `request`, so the cross-cutting concerns — cookie
 * credentials, OpenAI-shaped error unwrapping, and the "your session expired"
 * signal — are decided once instead of at each call site. The types here mirror
 * the API's responses rather than re-deriving them from core's zod schemas:
 * a stored document holds `${VAR}` and `{"$secret": id}` references that the
 * runtime types have already resolved away, so borrowing `OmniConfig` would
 * describe a shape this client never sees.
 */

/** Base path of the admin API, absolute so it works under the SPA's basepath. */
const BASE = "/admin/api";

/** A signed-in operator. */
export interface Actor {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
}

/** Whether the deployment still needs its first operator. */
export interface SetupState {
  needsFirstOperator: boolean;
  operators: number;
}

export interface StatusState {
  configured: boolean;
  revision: number | null;
  lastError: string | null;
  providers: string[];
  /** The applied user verifier, or null when nothing is configured. */
  userAuth: string | null;
  /** The applied app-attestation schemes, possibly none. */
  appAuth: string[];
  requireWriteKey: boolean | null;
  organizationName: string | null;
  customDomain: string | null;
}

/** A credential the operator never sees again: sealed into `omni_secrets`. */
export interface SecretRef {
  $secret: string;
}

export interface RoutingTarget {
  /** Named provider in the top-level providers map. */
  provider?: string;
  /** Optional named retry provider. */
  fallbackProvider?: string;
  /** Legacy inline provider discriminator, read-only compatibility. */
  type?: string;
  /** Upstream model to forward as. Absent forwards the client's model unchanged. */
  model?: string;
  [option: string]: unknown;
}

/** One reusable named model provider and its factory-specific options. */
export interface ProviderEntry {
  type: string;
  [option: string]: unknown;
}

export type ProvidersBlock = Record<string, ProviderEntry>;

export interface RoutingRule {
  id?: string;
  name?: string;
  when: string;
  target: RoutingTarget;
}

export interface RoutingBlock {
  allowedModels: string[];
  rules: RoutingRule[];
}

/** How much of something, per fixed window: `30000` tokens per `"1d"`. */
export interface RateLimitBudget {
  limit: number;
  window: string;
}

/**
 * One rate-limit rule: a token budget, counted per user.
 *
 * Every field but the budget is optional, and that shapes the screen: a rule with
 * no `when` applies to every request (the design's "Default" card), and a rule the
 * dashboard creates carries an `id` and no `name` because there is nowhere on the
 * screen to type one. Identity is `id ?? name`; the display name a 429 reports is
 * `name ?? id`.
 */
export interface RateLimitRule {
  id?: string;
  name?: string;
  /** Absent means every request. */
  when?: string;
  tokens: RateLimitBudget;
}

export interface VerifierEntry {
  type: string;
  name?: string;
  [option: string]: unknown;
}

/** Layer 2: app or device attestation, layered over the user. */
export interface AppAuthBlock {
  /** How several schemes combine. `any` is what a multi-platform deployment wants. */
  mode: "any" | "all";
  providers: VerifierEntry[];
}

export interface SecurityBlock {
  /** Layer 1: which user. Exactly one, and required before `/v1` will serve. */
  userAuth: VerifierEntry | null;
  appAuth: AppAuthBlock;
  publicPaths: string[];
  requireWriteKey: boolean;
}

/** Verdict from exercising a candidate authentication verifier. */
export type VerifierTestResponse =
  | { ok: true; message: string }
  | { ok: false; message: string; status?: number }
  | { ok: null; reason: string };

/** The stored configuration document: references, never plaintext. */
export interface StoredConfig {
  providers?: ProvidersBlock;
  routing?: Partial<RoutingBlock>;
  security?: Partial<SecurityBlock>;
  server?: Partial<ServerBlock>;
  /** Absent is not "none": the schema supplies defaults the proxy then enforces. */
  rateLimits?: RateLimitRule[];
  concurrency?: Partial<ConcurrencyBlock>;
  cache?: Partial<CacheBlock>;
  [block: string]: unknown;
}

export interface ConfigResponse {
  config: StoredConfig | null;
  revision: number | null;
  createdAt: number | null;
  createdBy: string | null;
  note: string | null;
  applied: boolean;
  appliedRevision: number | null;
  error: string | null;
}

/** What a save answers: the new revision, plus anything valid-but-suspect. */
export interface SaveResponse {
  revision: number;
  config: StoredConfig;
  warnings?: string[];
}

/** The response cache's configuration and contents, as one answer. */
export interface CacheState {
  /** False when the deployment has nowhere to cache (no database). */
  available: boolean;
  enabled: boolean;
  /** Duration string, e.g. `"1h"`. Null when nothing is applied. */
  ttl: string | null;
  maxEntries: number | null;
  maxBytes: number | null;
  entries: number;
  oldestAt: number | null;
  bytes: number | null;
}

/** Non-secret metadata and all-time usage for one publishable key. */
export interface PublishableKey {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  allowedModels: string[] | null;
  captureContent: boolean | null;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number | null;
  disabledAt: number | null;
  usage: {
    totalTokens: number;
    lastUsedAt: number | null;
    lastModel: string | null;
  };
}

/** A new publishable key; its plaintext is returned by the API exactly once. */
export interface CreatedPublishableKey {
  writeKey: Omit<PublishableKey, "usage">;
  secret: string;
}

/** A person with access to the operator dashboard. */
export interface TeamUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  createdAt: number;
}

/** An invitation that has not expired, been revoked, or been accepted. */
export interface TeamInvite {
  id: string;
  email: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

/** The one-time result of creating an invitation. */
export interface CreatedTeamInvite {
  invite: TeamInvite;
  link: string;
}

/** How many requests one user may have in flight. `0` disables the bound. */
export interface ConcurrencyBlock {
  perUser: number;
}

/** Response-cache settings, as stored. */
export interface CacheBlock {
  enabled: boolean;
  ttl: string;
  maxEntries: number;
  maxBytes: number;
}

/** Request-serving settings, preserving fields this screen does not edit. */
export interface ServerBlock {
  maxInputTokens: number;
  organizationName?: string;
  customDomain?: string;
  [setting: string]: unknown;
}

/** Which authentication question a verifier answers. */
export type AuthLayer = "user" | "app";

/** One registered component type and the options it accepts, as JSON Schema. */
export interface ComponentDescriptor {
  type: string;
  optionsSchema: JsonSchema | null;
}

export interface MetaResponse {
  providers: ComponentDescriptor[];
  /** Each verifier carries the layer it belongs to, so the screen can split them. */
  authVerifiers: (ComponentDescriptor & { layer: AuthLayer })[];
  storage: ComponentDescriptor[];
  secretsAvailable: boolean;
  logsAvailable: boolean;
}

/** Sensitive content returned only by the accountable single-log lookup. */
export interface RequestLogContent {
  messages: unknown;
  body?: unknown;
  headers?: Record<string, string>;
  completion: string | null;
  truncated: boolean;
}

/** One request-log row as exposed by the operator API. */
export interface RequestLog {
  id: string;
  requestId: string;
  ts: number;
  writeKeyId: string | null;
  writeKeyName: string | null;
  userId: string | null;
  deviceId: string | null;
  authProvider: string | null;
  modelRequested: string | null;
  modelRouted: string | null;
  providerId: string | null;
  routeName: string | null;
  stream: boolean;
  status: number;
  errorCode: string | null;
  rateLimitRule: string | null;
  cached: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  ttfbMs: number | null;
  ip: string | null;
  userAgent: string | null;
  content?: RequestLogContent;
}

/** A newest-first request-log page. */
export interface RequestLogsResponse {
  logs: RequestLog[];
  nextBefore: number | null;
}

/**
 * The slice of JSON Schema the generated forms read.
 *
 * Deliberately partial: `GET /meta` publishes whatever zod emits for each
 * factory, and a form that only understands the fields it can render degrades to
 * a text input rather than failing on an unfamiliar keyword.
 */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  minimum?: number;
  format?: string;
}

export type RuleOutcome = "match" | "no-match" | "non-boolean" | "error";

export interface RuleEvaluation {
  rule: string;
  providerType: string;
  outcome: RuleOutcome;
  error?: string;
  resultType?: string;
}

export interface SimulateResponse {
  matched: boolean;
  route?: string;
  provider?: string;
  model?: string;
  reason?: string;
  rules: RuleEvaluation[];
  warnings: string[];
}

/**
 * The result of probing a rule's upstream.
 *
 * `ok: null` is not a failure — it means this provider type answers `listModels`
 * from configuration and never contacted anything, so there is no verdict to give.
 */
export interface ProbeResponse {
  ok: boolean | null;
  latencyMs?: number;
  models?: number;
  status?: number | null;
  error?: string | null;
  reason?: string;
}

export interface SimulateInput {
  model: string;
  inputTokenCount?: number;
  maxTokens?: number;
  temperature?: number;
  claims?: Record<string, unknown>;
  userId?: string;
  providers?: string[];
  clientName?: string;
  ip?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}

/**
 * An admin API error, carrying the fields the API actually returns.
 *
 * `unauthenticated` is separated from every other failure because it is the one
 * the whole app reacts to structurally: a route guard redirects to sign-in
 * rather than rendering an error next to an empty page.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly param: string | null;

  constructor(status: number, message: string, code?: string | null, param?: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code ?? null;
    this.param = param ?? null;
  }

  /** A missing or expired session, as opposed to a signed-in non-operator. */
  get unauthenticated(): boolean {
    return this.status === 401;
  }

  /** Signed in, but without the operator role. */
  get forbidden(): boolean {
    return this.status === 403;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pull a message out of whatever the server sent.
 *
 * Errors arrive OpenAI-shaped from the proxy's own handler, but Better Auth
 * renders its own failures (`{ message }` or `{ error: { message } }`), so both
 * are unwrapped here rather than surfacing "[object Object]" to an operator
 * mistyping a password.
 */
function messageFrom(
  body: unknown,
  status: number,
): {
  message: string;
  code: string | null;
  param: string | null;
} {
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error)) {
      return {
        message: typeof error.message === "string" ? error.message : `request failed (${status})`,
        code: typeof error.code === "string" ? error.code : null,
        param: typeof error.param === "string" ? error.param : null,
      };
    }
    if (typeof error === "string") return { message: error, code: null, param: null };
    if (typeof body.message === "string") return { message: body.message, code: null, param: null };
  }
  return { message: `request failed (${status})`, code: null, param: null };
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    // Sessions are cookies. Without this the browser omits them and every
    // authenticated call is a 401 that looks like an expired session.
    credentials: "same-origin",
    headers: options.body === undefined ? {} : { "content-type": "application/json" },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  const parsed: unknown = text === "" ? null : safeParse(text);

  if (!response.ok) {
    const { message, code, param } = messageFrom(parsed, response.status);
    throw new ApiError(response.status, message, code, param);
  }
  return parsed as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  /** Unauthenticated by necessity: it answers whether sign-up is still open. */
  setup: () => request<SetupState>("/setup"),

  signIn: (email: string, password: string) =>
    request<unknown>("/auth/sign-in/email", { method: "POST", body: { email, password } }),

  /**
   * Create the first operator.
   *
   * Only possible while no account exists — the API closes this permanently
   * afterwards, and the account it creates is promoted to the operator role.
   */
  signUp: (email: string, password: string, name: string) =>
    request<unknown>("/auth/sign-up/email", { method: "POST", body: { email, password, name } }),

  signOut: () => request<unknown>("/auth/sign-out", { method: "POST", body: {} }),

  me: () => request<{ actor: Actor }>("/me").then((body) => body.actor),

  status: () => request<StatusState>("/status"),

  meta: () => request<MetaResponse>("/meta"),

  config: () => request<ConfigResponse>("/config"),

  /** Newest request metadata; sensitive content is deliberately excluded. */
  logs: (before?: number) =>
    request<RequestLogsResponse>(
      `/logs?limit=100${before === undefined ? "" : `&before=${encodeURIComponent(before)}`}`,
    ),

  /**
   * One request with opt-in captured content.
   *
   * The server audits every call because this can disclose prompts.
   */
  log: (requestId: string) =>
    request<{ log: RequestLog }>(`/logs/${encodeURIComponent(requestId)}?includeContent=true`).then(
      (body) => body.log,
    ),

  /**
   * Would this document work? Applies and stores nothing.
   *
   * The only authority on whether a CEL expression compiles: it builds a real
   * bundle from the candidate and throws it away, so its message is exactly the
   * one a save would have produced. 200 either way — "would this work" is a
   * successful question to ask.
   */
  validate: (config: unknown) =>
    request<{ valid: boolean; error?: string }>("/config/validate", {
      method: "POST",
      body: { config },
    }),

  /** Replace `security` wholesale. */
  putSecurity: (value: SecurityBlock, note?: string) =>
    request<SaveResponse>("/security", { method: "PUT", body: { value, note } }),

  /** Exercise an unsaved authentication verifier without persisting it. */
  testVerifier: (verifier: VerifierEntry) =>
    request<VerifierTestResponse>("/verifiers/test", {
      method: "POST",
      body: { verifier },
    }),

  /** Replace every named model provider in one validated revision. */
  putProviders: (value: ProvidersBlock, note?: string) =>
    request<SaveResponse>("/providers", { method: "PUT", body: { value, note } }),

  /** Replace `routing` wholesale — the only call that can express a new order. */
  putRouting: (value: RoutingBlock, note?: string) =>
    request<SaveResponse>("/routing", { method: "PUT", body: { value, note } }),

  /** Replace the whole `rateLimits` list. Order is the order rules are reported in. */
  putRateLimits: (value: RateLimitRule[], note?: string) =>
    request<SaveResponse>("/rate-limits", { method: "PUT", body: { value, note } }),

  /**
   * Replace several top-level blocks in one revision.
   *
   * What a screen editing more than one block uses: two PUTs would be two
   * revisions for one Save, and would leave the first applied if the second failed.
   */
  patchConfig: (value: Record<string, unknown>, note?: string) =>
    request<SaveResponse>("/config", { method: "PATCH", body: { value, note } }),

  /** What is in the response cache, and whether caching is on. */
  cache: () => request<CacheState>("/cache"),

  /** Empty it. Returns how many entries went. */
  purgeCache: () => request<{ purged: number }>("/cache", { method: "DELETE" }),

  /** List publishable-key descriptions and their aggregate usage, never plaintext. */
  publishableKeys: () =>
    request<{ writeKeys: PublishableKey[] }>("/write-keys").then((body) => body.writeKeys),

  /** Mint a publishable key. The returned secret cannot be retrieved again. */
  createPublishableKey: (name: string) =>
    request<CreatedPublishableKey>("/write-keys", { method: "POST", body: { name } }),

  /** Revoke a publishable key while retaining its usage attribution. */
  revokePublishableKey: (id: string) =>
    request<{ revoked: boolean; alreadyRevoked?: boolean }>(
      `/write-keys/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),

  /** Dashboard users and currently pending invitations. */
  team: () => request<{ users: TeamUser[]; invites: TeamInvite[] }>("/users"),

  /** Create an email-bound invitation. Its bearer link is returned exactly once. */
  createTeamInvite: (email: string) =>
    request<CreatedTeamInvite>("/users/invites", {
      method: "POST",
      body: { email },
    }),

  /** Make a pending invitation unusable. */
  revokeTeamInvite: (id: string) =>
    request<{ revoked: boolean }>(`/users/invites/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  /** Public metadata for the holder of an invitation link. */
  teamInvite: (token: string) =>
    request<{ invite: { email: string; expiresAt: number } }>(
      `/invites/${encodeURIComponent(token)}`,
    ).then((body) => body.invite),

  /** Create or promote the email-bound account and consume the invitation. */
  acceptTeamInvite: (token: string, password: string, name?: string) =>
    request<{ email: string }>(`/invites/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      body: { password, ...(name === undefined ? {} : { name }) },
    }),

  /** Insert or replace one rule, keeping its position if it already exists. */
  putRule: (id: string, value: Omit<RoutingRule, "id">, note?: string) =>
    request<SaveResponse>(`/routing/rules/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: { value, note },
    }),

  deleteRule: (id: string) =>
    request<SaveResponse>(`/routing/rules/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Probe the upstream the *applied* rule points at. */
  testRule: (id: string) =>
    request<ProbeResponse>(`/routing/rules/${encodeURIComponent(id)}/test`, { method: "POST" }),

  /**
   * Which models a candidate provider can serve — and whether its key works.
   *
   * Takes an unsaved provider entry, so an operator finds out a key is wrong while typing
   * it rather than when a client's request fails. `ok: false` means the upstream
   * refused; `ok: null` means this provider answers from configuration and never
   * contacted anything, so there is no verdict to give.
   */
  listUpstreamModels: (provider: ProviderEntry) =>
    request<{
      ok: boolean | null;
      models: string[];
      status?: number | null;
      error?: string | null;
      reason?: string;
    }>("/providers/models", { method: "POST", body: { provider } }),

  simulate: (input: SimulateInput) =>
    request<SimulateResponse>("/routing/simulate", { method: "POST", body: input }),
};

export type Api = typeof api;
