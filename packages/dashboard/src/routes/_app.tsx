import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppChrome } from "../components/chrome";
import { Callout } from "../components/ui/primitives";
import { type Actor, ApiError, api, type StatusState } from "../lib/api";

/**
 * Everything behind an operator session.
 *
 * The guard runs before any child loader, so a signed-out visitor never fetches
 * configuration and never renders a page that would only fill with 401s. Which
 * screen they land on depends on state only the server knows: a deployment with
 * no accounts needs its first operator, and sending that person to a sign-in form
 * they cannot use is a dead end.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async () => {
    let actor: Actor;
    try {
      actor = await api.me();
    } catch (error) {
      if (!(error instanceof ApiError) || !error.unauthenticated) throw error;
      const setup = await api.setup().catch(() => ({ needsFirstOperator: false, operators: 0 }));
      throw redirect({ to: setup.needsFirstOperator ? "/setup" : "/sign-in" });
    }
    return { actor };
  },
  loader: async ({ context }) => {
    // Status is chrome, not content: a proxy that cannot report its own state
    // should still let an operator fix the configuration that broke it.
    const status = await api.status().catch((): StatusState | null => null);
    return { actor: context.actor, status };
  },
  component: AppLayout,
});

function AppLayout() {
  const { actor, status } = Route.useLoaderData();
  return (
    <AppChrome actor={actor} status={status}>
      {status?.lastError != null ? (
        <div className="px-[24px] pt-[24px]">
          <Callout tone="danger" title="The stored configuration was rejected" role="alert">
            <p className="mt-[4px]">{status.lastError}</p>
            <p className="mt-[8px] type-label-12">
              The proxy is still serving the last configuration that built successfully, so what you
              see below may not be what is handling traffic.
            </p>
          </Callout>
        </div>
      ) : null}
      <Outlet />
    </AppChrome>
  );
}
