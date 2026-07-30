import { createMemoryHistory, HeadContent, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { expect } from "vitest";
import { getRouter } from "../../src/router";

/**
 * Mount the real router at a real URL.
 *
 * Not a component harness: the route tree, its `beforeLoad` guards and its
 * loaders all run. That matters because the interesting behaviour on these
 * screens *is* in the guards — a signed-out visitor being sent to sign-in, and a
 * deployment with no accounts being sent to setup instead, are decisions no
 * component test would ever reach.
 */
export async function renderAt(path: string) {
  const router = getRouter();
  router.update({
    history: createMemoryHistory({ initialEntries: [`/admin${path}`] }),
  });

  // The root route's shell renders `<html><head><body>`, which is right in a
  // browser and malformed inside a test container — `<html>` nested in a `<div>`.
  // Base UI's dialog walks the document to manage focus and scroll, and on that
  // malformed tree it never settles. Swapping the shell for a fragment keeps
  // every route, loader, guard, and route-managed head tag intact while giving
  // the dialog a sane document.
  // `shellComponent` is set by TanStack Start's route options and is not part of
  // the router's public `RouteOptions` type, hence the cast.
  const root = router.routesById.__root__ as unknown as {
    options: { shellComponent: (props: { children: ReactNode }) => ReactNode };
  };
  root.options.shellComponent = ({ children }) => (
    <>
      <HeadContent />
      {children}
    </>
  );

  const result = render(<RouterProvider router={router} />);

  // Loaders resolve on a microtask; without waiting, the first assertion races
  // the pending state and fails intermittently rather than usefully.
  await waitFor(() => {
    expect(router.state.status).toBe("idle");
  });

  return { ...result, router };
}

/** The path the router settled on, without the `/admin` basepath. */
export function currentPath(router: ReturnType<typeof getRouter>): string {
  return router.state.location.pathname.replace(/^\/admin/, "") || "/";
}

/**
 * Queries scoped to the open dialog.
 *
 * Necessary rather than convenient: a page and the modal over it legitimately
 * share field names — "Model" is on both the rule form and the simulate panel —
 * and an unscoped `getByLabelText` matches both. `getByRole` happens to work
 * because Base UI marks the rest of the document `aria-hidden`, which role
 * queries respect and label queries do not.
 */
export function dialog() {
  return within(screen.getByRole("dialog"));
}

/**
 * Open a Base UI select and choose an option.
 *
 * `findByRole` rather than `getByRole` on purpose: the popup mounts before it is
 * styled open, so for a frame its options are still inaccessible and a
 * synchronous query intermittently finds nothing. That race is invisible in a
 * fast test and shows up as a flake in a slow one.
 */
export async function selectOption(
  user: ReturnType<typeof userEvent.setup>,
  trigger: RegExp,
  option: string | RegExp,
) {
  await user.click(screen.getByRole("combobox", { name: trigger }));
  await user.click(await screen.findByRole("option", { name: option }));
}

/**
 * Set a multi-line field's value in one go.
 *
 * `user.type` cannot do this inside a `<form>`: it turns `\n` into an Enter
 * keypress, which submits the form instead of inserting a newline. Firing the
 * change directly is what a paste does, and it is the only way to get a
 * multi-line value into a field that lives in a form.
 */
export function setMultiline(field: HTMLElement, value: string): void {
  fireEvent.change(field, { target: { value } });
}
