import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The dashboard builds to a static bundle the proxy container serves at
 * `/admin`.
 *
 * SPA mode is deliberate: the dashboard talks to the admin API in the same
 * container over a session cookie, so there is no server-side rendering to do
 * and nothing to gain from a second runtime next to the proxy. The build output
 * is plain files, which `packages/node` serves with a history fallback.
 *
 * `base` and the router's `basePath` must agree — asset URLs come from the
 * former and in-app links from the latter, and a mismatch shows up as a blank
 * page with 404s for the JS.
 */
export default defineConfig({
  base: "/admin/",
  plugins: [
    tailwindcss(),
    tanstackStart({ spa: { enabled: true }, router: { basepath: "/admin" } }),
    viteReact(),
  ],
  resolve: {
    alias: {
      // Referenced from `styles.css`; Vite needs a filesystem path to fingerprint
      // and copy the font, and a bare package specifier in CSS is not resolvable.
      geist: fileURLToPath(new URL("./node_modules/geist", import.meta.url)),
    },
  },
});
