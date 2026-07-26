import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/**
 * The router, built fresh per call.
 *
 * TanStack Start calls this once at startup; tests call it per case so no route
 * state leaks between them.
 */
export function getRouter() {
  return createTanStackRouter({
    routeTree,
    basepath: "/admin",
    defaultPreload: "intent",
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
