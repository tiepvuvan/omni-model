import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEnv } from "@omni-model/core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDashboard, mountDashboard } from "../src/dashboard.js";

/**
 * Serving the dashboard is a static-file handler mounted next to an API, which
 * is exactly the arrangement where a path bug is quiet: a fallback that is too
 * greedy answers HTML to a fetch, and one that is too narrow breaks deep links.
 */
let build: string;

beforeEach(() => {
  build = mkdtempSync(join(tmpdir(), "omni-dashboard-"));
  mkdirSync(join(build, "assets"));
  writeFileSync(join(build, "_shell.html"), "<!DOCTYPE html><html><body>shell</body></html>");
  writeFileSync(join(build, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(join(build, "assets", "styles-abc123.css"), ":root{}");
  writeFileSync(join(build, "favicon.ico"), "icon");
});

afterEach(() => {
  rmSync(build, { recursive: true, force: true });
});

function appWith(directory: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Stand-in for the real admin API, mounted first as the server does.
  app.get("/admin/api/me", (c) => c.json({ actor: null }));
  app.get("/v1/models", (c) => c.json({ data: [] }));
  mountDashboard(app, { directory });
  return app;
}

describe("finding the build", () => {
  it("accepts a directory containing the shell", () => {
    expect(findDashboard(build)).toBe(build);
  });

  it("rejects a directory that has no shell", () => {
    expect(findDashboard(join(build, "assets"))).toBeNull();
  });

  it("reports nothing when the override does not exist", () => {
    expect(findDashboard(join(build, "nope"))).toBeNull();
  });
});

describe("serving", () => {
  it("does not mount when there is no build", () => {
    const app = new Hono<AppEnv>();
    expect(mountDashboard(app, { directory: join(build, "nope") })).toBe(false);
  });

  it("serves a fingerprinted asset with its content type", async () => {
    const response = await appWith(build).request("/admin/assets/index-abc123.js");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toBe("console.log(1)");
  });

  it("caches fingerprinted assets forever and the shell never", async () => {
    const app = appWith(build);

    const asset = await app.request("/admin/assets/styles-abc123.css");
    expect(asset.headers.get("cache-control")).toContain("immutable");

    // The shell references asset URLs by hash. Cached, a deploy would keep
    // handing out a shell pointing at files that no longer exist.
    const shell = await app.request("/admin/routing");
    expect(shell.headers.get("cache-control")).toBe("no-cache");
  });

  it("serves the shell for a deep link so a cold load works", async () => {
    const response = await appWith(build).request("/admin/routing");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("shell");
  });

  it("serves the shell for a nested deep link", async () => {
    const response = await appWith(build).request("/admin/some/deep/route");

    expect(await response.text()).toContain("shell");
  });

  it("redirects /admin to /admin/ so relative asset URLs resolve", async () => {
    const response = await appWith(build).request("/admin");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/");
  });

  it("leaves the admin API alone", async () => {
    const response = await appWith(build).request("/admin/api/me");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("404s an unknown API path instead of answering HTML", async () => {
    // The failure this prevents: a fetch for a mistyped endpoint receiving the
    // SPA shell, so the client reports a JSON parse error rather than a 404.
    const response = await appWith(build).request("/admin/api/nope");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  it("leaves the proxy's own routes alone", async () => {
    const response = await appWith(build).request("/v1/models");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [] });
  });

  it("refuses to escape the build directory", async () => {
    // A secret lives one level up in a real deployment, so a traversal here is
    // the difference between serving a bundle and serving the filesystem.
    writeFileSync(join(build, "..", "omni-dashboard-secret.txt"), "do not serve me");
    try {
      for (const path of [
        "/admin/../omni-dashboard-secret.txt",
        "/admin/..%2Fomni-dashboard-secret.txt",
        "/admin/assets/../../omni-dashboard-secret.txt",
        "/admin/%2e%2e%2fomni-dashboard-secret.txt",
      ]) {
        const response = await appWith(build).request(path);
        const body = await response.text();
        expect(body, `${path} must not read outside the build`).not.toContain("do not serve me");
      }
    } finally {
      rmSync(join(build, "..", "omni-dashboard-secret.txt"), { force: true });
    }
  });

  it("serves a file at the build root", async () => {
    const response = await appWith(build).request("/admin/favicon.ico");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/x-icon");
  });

  it("serves the shell for a directory path rather than listing it", async () => {
    const response = await appWith(build).request("/admin/assets");

    expect(await response.text()).toContain("shell");
  });
});

describe("the documented dashboard", () => {
  const page = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../docs/installation/dashboard.mdx"),
    "utf8",
  );

  it("documents the path this actually serves", async () => {
    // The docs tell an operator to open `/admin`. If that ever moves, the page
    // sends them somewhere that 404s, and nothing else would notice.
    expect(page).toContain("/admin");
    const response = await appWith(build).request("/admin");
    expect(response.status).toBe(302);
  });

  it("names the variable that switches it on", () => {
    // Mounting is conditional on the admin API existing, which `server.ts` gates
    // on this variable. A page that omits it describes a dashboard nobody can reach.
    expect(page).toContain("OMNI_ADMIN_SECRET");
  });
});

describe("revalidation", () => {
  it("sends validators so a browser can ask whether its copy is stale", async () => {
    // `no-cache` without an ETag or Last-Modified gives the browser nothing to
    // revalidate *with*, so the conditional request it wants to make is impossible
    // and freshness comes down to heuristics. That is how a deploy ends up serving
    // new files to a tab still rendering the old app.
    const response = await appWith(build).request("/admin/routing");

    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("etag")).toMatch(/^"[a-z0-9]+-[a-z0-9]+"$/);
    expect(response.headers.get("last-modified")).toBeTruthy();
  });

  it("answers 304 for a copy the client already has", async () => {
    const app = appWith(build);
    const first = await app.request("/admin/routing");
    const etag = first.headers.get("etag") ?? "";

    const second = await app.request("/admin/routing", { headers: { "if-none-match": etag } });

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    // The validators repeat, or the copy goes stale again on the next request.
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("answers 200 with a body once the file has changed", async () => {
    const app = appWith(build);
    const stale = '"0-0"';

    const response = await app.request("/admin/routing", {
      headers: { "if-none-match": stale },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("shell");
  });

  it("gives a rebuilt file a different tag", async () => {
    const first = await appWith(build).request("/admin/assets/index-abc123.js");
    // Same path, new contents — which is exactly a rebuild that reused a name.
    writeFileSync(join(build, "assets", "index-abc123.js"), "console.log(2) // rebuilt");
    const second = await appWith(build).request("/admin/assets/index-abc123.js");

    expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"));
  });
});
