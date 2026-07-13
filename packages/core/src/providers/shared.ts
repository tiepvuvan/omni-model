import type { OpenAIErrorBody } from "../openai/types.js";

/** Join a base URL and a path without doubling or dropping slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function openAIErrorBody(
  message: string,
  type: string,
  code: string | null = null,
): OpenAIErrorBody {
  return { error: { message, type, param: null, code } };
}

/**
 * Pull a human-readable message out of an upstream error payload. Handles the
 * OpenAI (`error.message`), Anthropic (`error.message`) and Google
 * (`error.message` / `error.status`) shapes, falling back to the raw text.
 */
export function extractUpstreamErrorMessage(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed !== null && typeof parsed === "object") {
      const error = (parsed as Record<string, unknown>).error;
      if (typeof error === "string") return error;
      if (error !== null && typeof error === "object") {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string" && message.length > 0) return message;
      }
      const message = (parsed as Record<string, unknown>).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
  } catch {
    // fall through to raw text
  }
  return bodyText.length > 0 ? bodyText.slice(0, 500) : "upstream request failed";
}

const ERROR_TYPE_BY_STATUS: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  408: "timeout_error",
  413: "invalid_request_error",
  422: "invalid_request_error",
  429: "rate_limit_error",
};

/**
 * Map an upstream non-2xx response to a client-facing error result.
 * 4xx statuses pass through (the client can act on them); 5xx become 502.
 */
export function upstreamErrorToResult(
  providerId: string,
  upstreamStatus: number,
  bodyText: string,
): { kind: "error"; status: number; body: OpenAIErrorBody } {
  const message = extractUpstreamErrorMessage(bodyText);
  const status = upstreamStatus >= 500 ? 502 : upstreamStatus;
  const type =
    upstreamStatus >= 500 ? "api_error" : (ERROR_TYPE_BY_STATUS[upstreamStatus] ?? "api_error");
  return {
    kind: "error",
    status,
    body: openAIErrorBody(`[provider ${providerId}] ${message}`, type, "upstream_error"),
  };
}

/**
 * Read a response body as text without throwing. A mid-body network failure
 * on an already-non-2xx response must still map to the upstream status, not
 * bubble up as a generic 500.
 */
export async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** A promise plus its resolver, for usage reporting from streams. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
