import { Pool } from "pg";

/**
 * A throwaway Postgres schema per suite.
 *
 * Every suite here runs migrations from scratch, so "applies to an empty
 * database" is a real assertion rather than something a previous run already
 * did. The schema is dropped afterwards, and its name carries the pid so two
 * suites running concurrently cannot collide.
 */
export interface ScopedSchema {
  /** Connection string with `search_path` pinned to this suite's schema. */
  url: string;
  /** Pool on the default search path, for asserting against raw tables. */
  owner: Pool;
  name: string;
  drop: () => Promise<void>;
}

export const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

export async function createScopedSchema(prefix: string): Promise<ScopedSchema> {
  if (POSTGRES_URL === undefined) throw new Error("TEST_POSTGRES_URL is not set");
  const name = `${prefix}_${process.pid.toString(36)}${Date.now().toString(36)}`;
  const owner = new Pool({ connectionString: POSTGRES_URL });
  await owner.query(`CREATE SCHEMA IF NOT EXISTS ${name}`);

  const scoped = new URL(POSTGRES_URL);
  scoped.searchParams.set("options", `-c search_path=${name}`);
  return {
    url: scoped.toString(),
    owner,
    name,
    drop: async () => {
      await owner.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
      await owner.end();
    },
  };
}

/** A tiny OpenAI-compatible upstream, as an injectable `fetch`. */
export function fakeUpstream(options: { model?: string } = {}): {
  fetch: typeof fetch;
  calls: number;
} {
  const model = options.model ?? "mock-model";
  const state = { calls: 0 };
  const impl: typeof fetch = async (input, init) => {
    state.calls += 1;
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: model, object: "model" }] });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
    if (body.stream === true) {
      const encoder = new TextEncoder();
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "streamed" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({
      id: "chatcmpl-e2e",
      object: "chat.completion",
      created: 1_700_000_000,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello from the fake upstream" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
    });
  };
  return {
    fetch: impl,
    get calls() {
      return state.calls;
    },
  };
}

/** A raw HS256 token the default `jwt` verifier accepts for `secret`. */
export async function signedToken(secret: string, subject = "user-e2e"): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ sub: subject, iat: now, exp: now + 3600 });
  const signature = createHmac("sha256", secret).update(`${head}.${payload}`).digest("base64url");
  return `${head}.${payload}.${signature}`;
}

/** Poll until `check` passes, or fail with what it last saw. */
export async function eventually<T>(
  check: () => Promise<T | null>,
  options: { timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result !== null) return result;
      last = result;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out waiting for ${options.label ?? "condition"}; last saw ${String(last)}`,
  );
}
