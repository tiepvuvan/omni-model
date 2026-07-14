import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RunningServer } from "@omni-model/node";
import { startServer } from "@omni-model/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end: the real omni-model Node server → OpenRouter (an OpenAI-compatible
 * upstream). Exercises the whole pipeline — routing, provider translation,
 * streaming, usage — against a live model.
 *
 * Opt-in: set `OPENROUTER_API_KEY` (and optionally `OMNI_E2E_MODEL`). Skipped
 * otherwise, so it never runs — or costs money — in the default suite.
 *
 *   OPENROUTER_API_KEY=... pnpm test:e2e
 */
const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OMNI_E2E_MODEL ?? "openai/gpt-4o-mini";
const configYaml = readFileSync(fileURLToPath(new URL("./omni.e2e.yaml", import.meta.url)), "utf8");

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
}

describe.skipIf(!KEY)("E2E: omni-model proxy → OpenRouter", () => {
  let server: RunningServer;
  let base: string;

  beforeAll(async () => {
    server = await startServer({
      configYaml,
      env: process.env,
      port: 0,
      hostname: "127.0.0.1",
    });
    base = `http://127.0.0.1:${server.port}`;
  }, 30_000);

  afterAll(async () => {
    await server?.close();
  });

  const post = (body: unknown): Promise<Response> =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("serves /healthz", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
  });

  it("completes a non-streaming chat", { timeout: 30_000 }, async () => {
    const res = await post({
      model: MODEL,
      messages: [{ role: "user", content: 'Reply with exactly the word "pong" and nothing else.' }],
      max_tokens: 10,
      temperature: 0,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      choices: { message: ChatMessage }[];
      usage?: { total_tokens: number };
    };
    expect(json.choices[0]?.message.content?.toLowerCase()).toContain("pong");
    expect(json.usage?.total_tokens ?? 0).toBeGreaterThan(0);
  });

  it("streams SSE deltas and a final usage chunk", { timeout: 30_000 }, async () => {
    const res = await post({
      model: MODEL,
      messages: [{ role: "user", content: "Count from 1 to 5, space-separated." }],
      max_tokens: 30,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const raw = await res.text();
    expect(raw).toContain("data: ");
    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);

    let content = "";
    let sawUsage = false;
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      const chunk = JSON.parse(payload) as {
        choices?: { delta?: { content?: string } }[];
        usage?: { total_tokens: number } | null;
      };
      content += chunk.choices?.[0]?.delta?.content ?? "";
      if (chunk.usage) sawUsage = true;
    }
    expect(content.length).toBeGreaterThan(0);
    expect(sawUsage).toBe(true);
  });

  it("does a tool-calling round-trip", { timeout: 45_000 }, async () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather for a city.",
          parameters: {
            type: "object",
            properties: { city: { type: "string", description: "City name" } },
            required: ["city"],
          },
        },
      },
    ];

    // Turn 1: the model should ask to call the tool.
    const first = await post({
      model: MODEL,
      messages: [
        { role: "user", content: "What is the weather in Paris? Use the get_weather tool." },
      ],
      tools,
      tool_choice: "auto",
      max_tokens: 100,
      temperature: 0,
    });
    expect(first.status).toBe(200);
    const j1 = (await first.json()) as {
      choices: { message: ChatMessage; finish_reason: string }[];
    };
    const assistant = j1.choices[0]?.message;
    const call = assistant?.tool_calls?.[0];
    expect(call, "expected a tool call").toBeTruthy();
    expect(call?.function.name).toBe("get_weather");
    expect(JSON.parse(call?.function.arguments ?? "{}").city?.toLowerCase()).toContain("paris");

    // Turn 2: feed the tool result back; the model should answer in text.
    const second = await post({
      model: MODEL,
      messages: [
        { role: "user", content: "What is the weather in Paris? Use the get_weather tool." },
        assistant,
        { role: "tool", tool_call_id: call?.id, content: "18°C and sunny" },
      ],
      max_tokens: 60,
      temperature: 0,
    });
    expect(second.status).toBe(200);
    const j2 = (await second.json()) as { choices: { message: ChatMessage }[] };
    const answer = j2.choices[0]?.message.content ?? "";
    expect(answer.length).toBeGreaterThan(0);
    expect(answer.toLowerCase()).toMatch(/18|sunny|paris|weather/);
  });

  it("maps an unknown model to an upstream error", { timeout: 30_000 }, async () => {
    const res = await post({
      model: "definitely/not-a-real-model-xyz",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 5,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const json = (await res.json()) as { error?: { message: string; type: string } };
    expect(json.error?.message).toBeTruthy();
  });
});
