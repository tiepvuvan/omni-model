import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEnv, Logger } from "@omni-model/core";
import type { Hono } from "hono";

/** Where the dashboard build lands, relative to this package's `dist`. */
const BUNDLED = ["../dashboard", "../../dashboard/dist/client"];

/** The prerendered SPA shell, served for any in-app route. */
const SHELL = "_shell.html";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot === -1 ? undefined : CONTENT_TYPES[path.slice(dot)]) ?? "application/octet-stream";
}

/**
 * Locate the built dashboard, or return null when it was not built.
 *
 * Two candidates because the layout differs between the container — where the
 * build is copied next to the server bundle — and a checkout, where it is still
 * in the dashboard package's `dist`. An explicit `OMNI_DASHBOARD_DIR` overrides
 * both.
 */
export function findDashboard(override?: string): string | null {
  if (override !== undefined && override.trim() !== "") {
    const path = resolve(override);
    return existsSync(join(path, SHELL)) ? path : null;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of BUNDLED) {
    const path = resolve(here, candidate);
    if (existsSync(join(path, SHELL))) return path;
  }
  return null;
}

/**
 * Serve the dashboard at `/admin`, with a history fallback.
 *
 * Static files come from the build; anything else under `/admin` that is not the
 * API returns the SPA shell so a deep link like `/admin/routing` works on a cold
 * load. `/admin/api/*` is deliberately not touched — it is already mounted, and
 * a fallback that swallowed an unknown API path would answer HTML to a fetch and
 * turn a 404 into an unparseable response.
 *
 * Returns whether anything was mounted, so the caller can say so once at boot.
 */
export function mountDashboard(
  app: Hono<AppEnv>,
  options: { directory?: string; logger?: Logger } = {},
): boolean {
  const root = findDashboard(options.directory);
  if (root === null) {
    options.logger?.info(
      "dashboard not mounted: no build found (the container image ships one; " +
        "in a checkout run `pnpm --filter @omni-model/dashboard run build`)",
    );
    return false;
  }

  const shell = join(root, SHELL);

  const sendFile = async (path: string, cacheable: boolean): Promise<Response> => {
    const body = await readFile(path);
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": contentType(path),
        // Vite fingerprints everything under `assets/`, so those are immutable;
        // the shell must never be cached or a deploy keeps serving old asset URLs.
        "cache-control": cacheable ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  };

  // Before the wildcard: `/admin/*` also matches `/admin`, so registering the
  // redirect afterwards would make it unreachable and leave two URLs serving the
  // same page.
  app.get("/admin", (c) => c.redirect("/admin/", 302));

  app.get("/admin/*", async (c) => {
    const path = c.req.path.slice("/admin/".length);

    // The API is mounted separately and owns its own 404s.
    if (path === "api" || path.startsWith("api/")) return c.notFound();

    if (path !== "") {
      // `normalize` then a prefix check: a request for `..%2f..%2fetc/passwd`
      // decodes to a traversal, and resolving before comparing is the only way to
      // be sure the result is still inside the build directory.
      const candidate = resolve(root, normalize(path));
      if (candidate === root || candidate.startsWith(root + sep)) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return sendFile(candidate, path.startsWith("assets/"));
        }
      }
    }

    // Not a file: hand back the shell and let the client router decide. A cold
    // load of `/admin/routing` has to work, and only the SPA knows that route.
    return sendFile(shell, false);
  });

  options.logger?.info("dashboard mounted at /admin", { from: root });
  return true;
}
