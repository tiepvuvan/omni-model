import { ConfigError } from "../errors.js";

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parse a duration like "30s", "5m", "1h" or "1d" into milliseconds. */
export function parseDuration(input: string): number {
  const match = DURATION_PATTERN.exec(input.trim());
  if (match === null) {
    throw new ConfigError(`invalid duration "${input}" (expected e.g. "30s", "5m", "1h", "1d")`);
  }
  const digits = match[1] as string;
  const unit = match[2] as keyof typeof UNIT_MS;
  return Number(digits) * UNIT_MS[unit];
}
