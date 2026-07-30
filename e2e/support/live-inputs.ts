import { readFileSync } from "node:fs";

/** Read a secret-bearing input file when it exists; absent or blank files leave a live gate closed. */
export function readOptionalLiveInput(path: string | undefined): string | undefined {
  if (path === undefined || path === "") return undefined;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Read a required secret-bearing input without including its path or contents in an error. */
export function readRequiredLiveInput(path: string, variable: string): string {
  const value = readOptionalLiveInput(path);
  if (value === undefined) throw new Error(`${variable} points to an unreadable or empty file`);
  return value;
}
