import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
/*
 * Imported for its side effect rather than as `styles.css?url`.
 *
 * `?url` emits the stylesheet as a standalone asset, which the client build and
 * the prerender pass hash independently — and when Tailwind's class scan differs
 * even slightly between them, the shell ends up linking a filename the build
 * never wrote. The result is a 404 for the stylesheet and a completely unstyled
 * dashboard on a cold load. A plain import makes the CSS part of the client
 * entry's chunk, so the link in the shell comes from the same manifest that
 * named the file. `scripts/verify-build.mjs` fails the build if that ever drifts
 * again.
 */
import "../styles.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      // The dashboard is an operator console behind a session; nothing about it
      // should ever appear in a search index.
      { name: "robots", content: "noindex, nofollow" },
      { title: "omni-model" },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/*
         * Applied before first paint, from the same storage key the theme toggle
         * writes. Doing this in React would flash the light theme first, and the
         * string below is a literal with nothing interpolated into it.
         */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a pre-paint inline script is the only way to avoid a theme flash; the content is a literal.
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("omni-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

export function RootComponent() {
  return <Outlet />;
}
