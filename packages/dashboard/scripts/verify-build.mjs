#!/usr/bin/env node
/**
 * Check that the prerendered shell only references files the build wrote.
 *
 * This runs as part of `pnpm run build`, not as a test, because the failure it
 * catches only exists in build output — and a test that needs a build to have
 * happened first is a test that quietly skips.
 *
 * The bug it exists for: the shell is rendered by the SSR pass while assets are
 * named by the client pass. Ask for a stylesheet as a standalone asset (`?url`)
 * and the two passes hash it independently, so the shell can link a filename that
 * was never written. The dashboard then loads with no styles at all, and nothing
 * about the build says so — every step exits zero.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = join(root, "dist/client");
const shellPath = join(client, "_shell.html");

if (!existsSync(shellPath)) {
  process.stderr.write(`verify-build: ${shellPath} is missing; did the build run?\n`);
  process.exit(1);
}

const shell = readFileSync(shellPath, "utf8");

/** Every `/admin/...` URL the shell mentions anywhere, deduplicated. */
const referenced = [...new Set(shell.match(/\/admin\/[A-Za-z0-9/._-]+/g) ?? [])];

const missing = referenced.filter((url) => !existsSync(join(client, url.slice("/admin/".length))));

/**
 * Tags, not URL mentions.
 *
 * A URL can appear in the shell's inline router manifest without any tag loading
 * it, so counting `.css` mentions would pass a shell that links no stylesheet at
 * all. What matters is that a `<link rel="stylesheet">` and a module `<script>`
 * are actually present — a shell missing either loads blank or unstyled while
 * every build step still exits zero.
 */
const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
const tags = (name) => shell.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];

const styles = tags("link")
  .filter((tag) => attr(tag, "rel") === "stylesheet")
  .map((tag) => attr(tag, "href"))
  .filter((href) => href !== undefined);
const scripts = tags("script")
  .map((tag) => attr(tag, "src"))
  .filter((src) => src !== undefined);

const problems = [];
if (missing.length > 0)
  problems.push(`references files the build did not write: ${missing.join(", ")}`);
if (scripts.length === 0) {
  problems.push("has no <script src>, so the app would never start");
}
if (styles.length === 0) {
  problems.push('has no <link rel="stylesheet">, so the app would render unstyled');
}

if (problems.length > 0) {
  process.stderr.write(`verify-build: dist/client/_shell.html ${problems.join("; ")}\n`);
  process.exit(1);
}

process.stdout.write(
  `verify-build: ${referenced.length} referenced assets all present ` +
    `(${scripts.length} scripts, ${styles.length} stylesheets)\n`,
);
