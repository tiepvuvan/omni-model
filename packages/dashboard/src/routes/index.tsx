import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/admin` itself has no content — it sends the operator where they can act.
 *
 * Where that is depends on state the client cannot guess, so the decision is
 * made in `beforeLoad` against the API rather than by rendering something and
 * correcting it afterwards.
 */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/routing" });
  },
});
