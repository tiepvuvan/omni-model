import { type RunningServer, startServer } from "@omni-model/node";
import { authHeaders, E2E_JWT_SECRET } from "./auth.js";

const UPSTREAM_URL = "https://live-verification-upstream.invalid/v1/chat/completions";
const CHAT_BODY = JSON.stringify({
  model: "smart",
  messages: [{ role: "user", content: "verify this request" }],
  max_tokens: 4,
});

/** A running proxy whose verifier calls the real vendor while its model upstream stays local. */
export interface LiveVerificationTarget {
  /** Send one protected request with a fresh vendor proof. */
  request(header: string, proof: string): Promise<Response>;
  /** Number of requests that passed verification and reached the deterministic model upstream. */
  upstreamCalls(): number;
  /** Stop the ephemeral proxy. */
  stop(): Promise<void>;
}

/** Security configuration for a live provider test backed by a deterministic model upstream. */
export interface LiveSecurityOptions {
  /** The real user-auth verifier under test. */
  userAuth: Record<string, unknown>;
  /** Optional application-verification layer under test. */
  appAuth?: {
    mode: "all" | "any";
    providers: Record<string, unknown>[];
  };
  /** Runtime environment used by provider integrations such as Firebase Admin. */
  env?: Record<string, string | undefined>;
  /** Headers included with every request, typically a deterministic user credential. */
  defaultHeaders?: () => Promise<Record<string, string>>;
}

/** A running proxy with caller-controlled user and application credentials. */
export interface LiveSecurityTarget {
  /** Send one protected request through the configured security layers. */
  request(headers?: Record<string, string>): Promise<Response>;
  /** Number of requests that passed every security layer and reached model routing. */
  upstreamCalls(): number;
  /** Stop the ephemeral proxy. */
  stop(): Promise<void>;
}

/**
 * Start a real proxy for one or more live security providers.
 *
 * Only identity and attestation traffic reaches the network. The model
 * upstream is intercepted locally, making success deterministic and free.
 */
export async function startLiveSecurityTarget(
  options: LiveSecurityOptions,
): Promise<LiveSecurityTarget> {
  const target = await startTarget(options);
  return {
    async request(headers: Record<string, string> = {}): Promise<Response> {
      return target.request({
        ...(options.defaultHeaders === undefined ? {} : await options.defaultHeaders()),
        ...headers,
      });
    },
    upstreamCalls: target.upstreamCalls,
    stop: target.stop,
  };
}

/**
 * Start a real omni-model HTTP server for a live verifier contract.
 *
 * Vendor traffic uses the real network. Model traffic is intercepted locally,
 * so these tests need no provider API key and cannot spend model tokens.
 */
export async function startLiveVerificationTarget(
  appAuthProvider: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): Promise<LiveVerificationTarget> {
  const target = await startLiveSecurityTarget({
    userAuth: {
      type: "jwt",
      secret: E2E_JWT_SECRET,
      algorithms: ["HS256"],
    },
    appAuth: {
      mode: "all",
      providers: [appAuthProvider],
    },
    env,
    defaultHeaders: authHeaders,
  });

  return {
    request: (header, proof) => target.request({ [header]: proof }),
    upstreamCalls: target.upstreamCalls,
    stop: target.stop,
  };
}

async function startTarget(options: LiveSecurityOptions): Promise<LiveSecurityTarget> {
  const networkFetch = globalThis.fetch;
  let upstreamCallCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === UPSTREAM_URL) {
      upstreamCallCount += 1;
      return Response.json({
        id: "chatcmpl-live-verification",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1_000),
        model: "deterministic-upstream",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "verified" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    }
    return networkFetch(input, init);
  };

  const server: RunningServer = await startServer({
    port: 0,
    hostname: "127.0.0.1",
    env: options.env ?? {},
    fetch: fetchImpl,
    config: {
      version: 1,
      storage: { type: "memory" },
      server: { logLevel: "silent" },
      security: {
        userAuth: options.userAuth,
        ...(options.appAuth === undefined ? {} : { appAuth: options.appAuth }),
      },
      routing: {
        rules: [
          {
            id: "deterministic-upstream",
            when: "true",
            target: {
              type: "openai-compatible",
              baseUrl: "https://live-verification-upstream.invalid/v1",
            },
          },
        ],
      },
    },
  });

  return {
    async request(headers: Record<string, string> = {}): Promise<Response> {
      return fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: CHAT_BODY,
      });
    },
    upstreamCalls: () => upstreamCallCount,
    stop: () => server.close(),
  };
}
