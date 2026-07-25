import {
  CelExpressionEngine,
  createBundleHolder,
  createDefaultRegistry,
  createKeyring,
  createMemorySecretStore,
  type Logger,
  MemoryConfigStore,
  MemoryStorageAdapter,
  MemoryWriteKeyStore,
  type RuntimeContext,
  silentLogger,
} from "@omni-model/core";
import type { PgPoolLike } from "@omni-model/postgres";
import type { AdminApp, AdminAuthLike } from "../src/index.js";
import { createAdminApp } from "../src/index.js";

/** A fixed clock, so log windows and expiry are deterministic. */
export const FIXED_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** 32 zero bytes; only ever used to seal test values. */
export const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * A minimal working configuration.
 *
 * One provider, one verifier — the smallest document `buildBundle` accepts, so a
 * test that changes one block is not also asserting the rest.
 */
export function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storage: { type: "memory" },
    providers: {
      default: { type: "openai", apiKey: "sk-test", baseUrl: "https://upstream.test/v1" },
    },
    security: {
      providers: [
        { type: "jwt", issuer: "https://issuer.test", audience: "test", secret: "s".repeat(32) },
      ],
    },
    routing: { defaultProvider: "default" },
    ...overrides,
  };
}

/** A stand-in operator session. */
export interface FakeActor {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

/**
 * An auth instance that reads the session from a header instead of a cookie.
 *
 * Better Auth itself is exercised against a real database in
 * `auth.integration.test.ts`. Here the point is the *authorization* rules and
 * the endpoints behind them, and a fake keeps those tests offline: the
 * alternative is that every assertion about a 403 needs Postgres running.
 */
export function fakeAuth(users: Record<string, FakeActor>): AdminAuthLike {
  return {
    handler: async (request: Request) =>
      new Response(JSON.stringify({ handled: new URL(request.url).pathname }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    api: {
      getSession: async ({ headers }) => {
        const token = headers.get("x-test-session");
        const user = token === null ? undefined : users[token];
        return user === undefined ? null : { user, session: { id: `session-${token}` } };
      },
    },
  };
}

/**
 * A pool that answers the queries the admin app makes, with no rows.
 *
 * Enough to exercise the request-log and usage endpoints — their SQL is covered
 * against a real database in `packages/postgres`, and what matters here is the
 * HTTP shape around it. Anything unrecognised throws, so a new query cannot be
 * silently answered with an empty result.
 */
export function fakePool(options: { users?: number } = {}): PgPoolLike {
  const users = options.users ?? 0;
  return {
    // Better Auth and our raw statements pass a string; Drizzle passes a query
    // object and asks for array row mode, so both forms have to be handled.
    query: async (arg: unknown) => {
      const config = typeof arg === "string" ? { text: arg } : (arg as { text: string });
      const text = config.text;
      const empty = { rows: [], rowCount: 0, fields: [] };

      if (text.includes('FROM "user" LIMIT 1')) {
        return { rows: users > 0 ? [{ 1: 1 }] : [], rowCount: users > 0 ? 1 : 0 };
      }
      if (text.includes('count(*)::int AS n FROM "user"')) {
        return { rows: [{ n: users }], rowCount: 1 };
      }
      // Promotion of the first operator; the fake sign-up returns no user id, so
      // this is only reached when a test drives it directly.
      if (text.includes('UPDATE "user" SET role')) {
        return { rows: [{ id: "u-first" }], rowCount: 1 };
      }
      // Log and usage queries: no rows, which is a real state (nothing logged
      // yet) and enough to exercise the HTTP shape around them.
      if (text.includes("omni_request_logs")) return empty;
      throw new Error(`unexpected query in a pool-free test: ${text}`);
    },
  } as unknown as PgPoolLike;
}

export interface TestAdmin {
  admin: AdminApp;
  holder: ReturnType<typeof createBundleHolder>;
  configStore: MemoryConfigStore;
  writeKeys: MemoryWriteKeyStore;
  /** Call the admin app as an operator (or nobody, with `session: null`). */
  call(path: string, init?: RequestInit & { session?: string | null }): Promise<Response>;
}

export interface CreateTestAdminOptions {
  /** Seed the config store and apply it. */
  config?: Record<string, unknown>;
  /** Number of existing operator accounts, for the sign-up gate. */
  users?: number;
  /** Omit the secret store, to exercise the 503 path. */
  withSecrets?: boolean;
  pool?: PgPoolLike;
  /** Upstream double, for provider probes. */
  fetch?: typeof fetch;
  /** Capture what the admin API logs, for audit assertions. */
  logger?: Logger;
}

/**
 * A complete admin app over in-memory stores.
 *
 * Everything except Better Auth is the real implementation: the same holder, the
 * same config store contract, the same registry — so a passing test here means
 * the endpoint agrees with the machinery it drives, not with a mock of it.
 */
export async function createTestAdmin(options: CreateTestAdminOptions = {}): Promise<TestAdmin> {
  const runtime: RuntimeContext = {
    env: {},
    fetch:
      options.fetch ??
      (async () =>
        new Response('{"data":[]}', { headers: { "content-type": "application/json" } })),
    now: () => FIXED_NOW,
    waitUntil: () => {},
    log: silentLogger,
  };
  const storage = new MemoryStorageAdapter();
  const secrets =
    options.withSecrets === false
      ? null
      : createMemorySecretStore(await createKeyring({ active: TEST_KEY }));
  const holder = createBundleHolder({
    registry: createDefaultRegistry(),
    storage,
    engine: new CelExpressionEngine(),
    runtime,
    logger: silentLogger,
    log: silentLogger,
    ...(secrets === null ? {} : { secrets }),
  });
  const configStore = new MemoryConfigStore();
  const writeKeys = new MemoryWriteKeyStore(() => FIXED_NOW);

  if (options.config !== undefined) {
    const saved = await configStore.save(options.config, { createdBy: "test" });
    const applied = await holder.reload(saved.document, { revision: saved.revision });
    if (!applied.ok) throw new Error(`test config was rejected: ${applied.error}`);
  }

  const users: Record<string, FakeActor> = {
    root: { id: "u-root", email: "root@test", name: "Root", role: "admin" },
    // Signed in, but not an operator: the 403 case.
    member: { id: "u-member", email: "member@test", name: "Member", role: "user" },
  };

  const admin = createAdminApp({
    pool: options.pool ?? fakePool({ users: options.users ?? 0 }),
    auth: fakeAuth(users),
    holder,
    configStore,
    writeKeys,
    secrets,
    registry: createDefaultRegistry(),
    runtime,
    logger: options.logger ?? silentLogger,
  });

  return {
    admin,
    holder,
    configStore,
    writeKeys,
    call: async (path, init = {}) => {
      const { session, ...rest } = init;
      const headers = new Headers(rest.headers);
      // Default to the operator: most tests are about the endpoint, not authz.
      const token = session === undefined ? "root" : session;
      if (token !== null) headers.set("x-test-session", token);
      if (rest.body !== undefined && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      return admin.app.request(`http://admin.test${path}`, { ...rest, headers });
    },
  };
}

/** The `error` object from an OpenAI-style error response. */
export async function errorOf(
  response: Response,
): Promise<{ message: string; code: string | null; type: string }> {
  const body = (await response.json()) as {
    error?: { message?: string; code?: string | null; type?: string };
  };
  return {
    message: body.error?.message ?? "",
    code: body.error?.code ?? null,
    type: body.error?.type ?? "",
  };
}
