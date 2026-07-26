import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { type Actor, api, type StatusState } from "../lib/api";
import { Badge, Button, cx } from "./ui/primitives";

const NAV = [
  { to: "/routing", label: "Model routing" },
  { to: "/authentication", label: "Client authentication" },
] as const;

/** The stored theme choice; read pre-paint by an inline script in `__root`. */
const THEME_KEY = "omni-theme";

function useTheme(): ["light" | "dark", () => void] {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof document === "undefined") return "light";
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // A locked-down browser profile can refuse storage. The theme still
      // applies for this page; only remembering it is lost.
    }
  }, [theme]);

  return [theme, useCallback(() => setTheme((now) => (now === "dark" ? "light" : "dark")), [])];
}

/**
 * The signed-in chrome: navigation, who you are, and what the proxy is doing.
 *
 * The revision badge is here rather than on a page because it answers a question
 * that applies to every page — "is what I am looking at what is serving traffic"
 * — and `error` being non-null means a stored revision was *rejected*, so the
 * proxy is still serving something older than what the pages show.
 */
export function Shell({
  actor,
  status,
  children,
}: {
  actor: Actor;
  status: StatusState | null;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const [theme, toggleTheme] = useTheme();

  const signOut = async () => {
    try {
      await api.signOut();
    } finally {
      // Even a failed sign-out should land on the sign-in screen: the operator
      // asked to leave, and the guard will send them back if the cookie survived.
      await navigate({ to: "/sign-in" });
    }
  };

  return (
    /*
     * A viewport-height frame with exactly one scroll region.
     *
     * `min-h-full` was wrong: the wrapper grew with the page, the sidebar
     * stretched with it, and `overflow-y-auto` on an unbounded `main` did nothing
     * — so the document scrolled and the sidebar footer, sign-out included, ended
     * up below the fold on any page taller than the window. `dvh` rather than
     * `vh` so mobile browser chrome does not cut off the bottom.
     */
    <div className="flex h-dvh overflow-hidden">
      <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-background-l2">
        <div className="flex items-center gap-2 px-5 py-5">
          <span className="text-sm font-semibold tracking-tight text-foreground-primary">
            omni-model
          </span>
        </div>

        <nav className="flex flex-1 flex-col gap-1 px-3">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="rounded-[var(--radius-field)] px-3 py-2 text-sm text-foreground-secondary hover:bg-item-selection hover:text-foreground-primary"
              activeProps={{
                className:
                  "rounded-[var(--radius-field)] px-3 py-2 text-sm bg-item-selection text-foreground-primary font-medium",
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex flex-col gap-3 border-t border-border px-5 py-4">
          {status !== null ? (
            <div className="flex flex-col gap-1.5">
              {status.lastError != null ? (
                <Badge tone="danger">revision rejected</Badge>
              ) : (
                <Badge tone={status.configured ? "success" : "warning"}>
                  {status.configured ? `revision ${status.revision ?? "—"}` : "not configured"}
                </Badge>
              )}
              <span className="text-xs text-foreground-secondary">
                {status.verifiers.length} verifier{status.verifiers.length === 1 ? "" : "s"} ·{" "}
                {status.providers.length} rule{status.providers.length === 1 ? "" : "s"}
              </span>
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            <span
              className="truncate text-xs font-medium text-foreground-primary"
              title={actor.email}
            >
              {actor.email}
            </span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" className="px-2 py-1 text-xs" onClick={signOut}>
                Sign out
              </Button>
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs"
                onClick={toggleTheme}
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              >
                {theme === "dark" ? "Light" : "Dark"}
              </Button>
            </div>
          </div>
        </div>
      </aside>

      {/* `min-h-0` is what lets a flex child actually scroll instead of growing. */}
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

/** A page's title block. Sized and spaced once so every screen agrees. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("flex items-start justify-between gap-6 px-8 pb-6 pt-8", className)}>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground-primary">{title}</h1>
        {description !== undefined ? (
          <p className="max-w-2xl text-sm text-foreground-secondary">{description}</p>
        ) : null}
      </div>
      {actions !== undefined ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </header>
  );
}

/** The page body: one column of panels, consistent gutter. */
export function PageBody({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-6 px-8 pb-12">{children}</div>;
}
