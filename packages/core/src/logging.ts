import type { Logger } from "./types.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Logger that writes to the console, filtering below `level`. */
export function createConsoleLogger(level: LogLevel = "info"): Logger {
  const threshold = LEVEL_ORDER[level];
  const emit = (
    method: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (LEVEL_ORDER[method] < threshold) return;
    if (fields !== undefined && Object.keys(fields).length > 0) {
      console[method](`[omni] ${message}`, fields);
    } else {
      console[method](`[omni] ${message}`);
    }
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
