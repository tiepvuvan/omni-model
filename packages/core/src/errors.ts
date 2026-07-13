import type { OpenAIErrorBody } from "./openai/types.js";

/** Raised for invalid configuration. Fails fast at startup, never mid-request. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface OmniErrorOptions {
  type?: string;
  code?: string | null;
  param?: string | null;
  headers?: Record<string, string>;
  cause?: unknown;
}

/** HTTP-mappable error rendered as an OpenAI-style error body. */
export class OmniError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;
  readonly param: string | null;
  readonly headers: Record<string, string>;

  constructor(status: number, message: string, options: OmniErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OmniError";
    this.status = status;
    this.type = options.type ?? defaultTypeForStatus(status);
    this.code = options.code ?? null;
    this.param = options.param ?? null;
    this.headers = options.headers ?? {};
  }

  toBody(): OpenAIErrorBody {
    return {
      error: { message: this.message, type: this.type, param: this.param, code: this.code },
    };
  }

  toResponse(): Response {
    return Response.json(this.toBody(), { status: this.status, headers: this.headers });
  }
}

function defaultTypeForStatus(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

export function badRequest(message: string, options: OmniErrorOptions = {}): OmniError {
  return new OmniError(400, message, options);
}

export function unauthorized(message: string, options: OmniErrorOptions = {}): OmniError {
  return new OmniError(401, message, options);
}

export function forbidden(message: string, options: OmniErrorOptions = {}): OmniError {
  return new OmniError(403, message, options);
}

export function notFound(message: string, options: OmniErrorOptions = {}): OmniError {
  return new OmniError(404, message, options);
}

export function rateLimited(message: string, retryAfterSeconds?: number): OmniError {
  const headers: Record<string, string> = {};
  if (retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(retryAfterSeconds)));
  }
  return new OmniError(429, message, { code: "rate_limit_exceeded", headers });
}

export function upstreamError(status: number, message: string): OmniError {
  return new OmniError(status >= 500 ? 502 : status, message, {
    type: "api_error",
    code: "upstream_error",
  });
}
