import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import chevronIcon from "../assets/chevron.svg";
import navAuthentication from "../assets/nav-authentication.svg";
import navLogs from "../assets/nav-logs.svg";
import navRateLimit from "../assets/nav-rate-limit.svg";
import navRouting from "../assets/nav-routing.svg";
import navSettings from "../assets/nav-settings.svg";
import navUsers from "../assets/nav-users.svg";
import { type Actor, api, type StatusState } from "../lib/api";
import { Badge, Button, cx } from "./ui/primitives";

/**
 * The chrome from the design: a 60px header bar over a 300px sidebar and the
 * content pane.
 *
 * Navigation lists what the deployment has, in the design's order. `Rate Limit`,
 * `Logs`, `Users` and `Settings` appear in the file and have no screen yet, so
 * they render disabled rather than being dropped — the sidebar is the map of the
 * product, and silently shortening it makes the built screens look like the whole
 * of it.
 */
const NAV: readonly {
  label: string;
  icon: string;
  to?: "/routing" | "/authentication";
}[] = [
  { label: "Authentication", icon: navAuthentication, to: "/authentication" },
  { label: "Routing", icon: navRouting, to: "/routing" },
  { label: "Rate Limit", icon: navRateLimit },
  { label: "Logs", icon: navLogs },
];

const ADMIN_NAV: readonly { label: string; icon: string }[] = [
  { label: "Users", icon: navUsers },
  { label: "Settings", icon: navSettings },
];

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

const NAV_ITEM =
  "flex w-full items-center gap-[8px] rounded-[var(--radius-nav)] p-[8px] type-copy-14";

function NavIcon({ src }: { src: string }) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      className="size-[20px] shrink-0 overflow-clip rounded-[4px]"
    />
  );
}

function Sidebar() {
  return (
    <nav
      aria-label="Sections"
      className="flex w-[300px] shrink-0 flex-col gap-px self-stretch border-r border-solid border-border p-[8px]"
    >
      {NAV.map((item) =>
        item.to === undefined ? (
          <span
            key={item.label}
            aria-disabled
            title="Not built yet"
            className={cx(NAV_ITEM, "cursor-default text-foreground-secondary opacity-50")}
          >
            <NavIcon src={item.icon} />
            {item.label}
          </span>
        ) : (
          <Link
            key={item.label}
            to={item.to}
            className={cx(NAV_ITEM, "text-foreground-primary")}
            activeProps={{ className: cx(NAV_ITEM, "bg-item-selection text-foreground-primary") }}
          >
            <NavIcon src={item.icon} />
            {item.label}
          </Link>
        ),
      )}

      <div className="flex w-full items-center gap-[6px] pb-[6px] pl-[2px] pr-[8px] pt-[12px]">
        <img src={chevronIcon} alt="" aria-hidden className="h-[11px] w-[10px] shrink-0" />
        <span className="type-strong-13 text-foreground-secondary">Admin</span>
      </div>

      {ADMIN_NAV.map((item) => (
        <span
          key={item.label}
          aria-disabled
          title="Not built yet"
          className={cx(NAV_ITEM, "cursor-default text-foreground-secondary opacity-50")}
        >
          <NavIcon src={item.icon} />
          {item.label}
        </span>
      ))}
    </nav>
  );
}

/**
 * The operator's initial in the design's 32px circle.
 *
 * The file shows a photograph here, which is a placeholder for whoever is signed
 * in rather than an asset to ship — there is no avatar in the data model, and
 * shipping a stock portrait of a stranger would be worse than wrong.
 */
function Avatar({ actor }: { actor: Actor }) {
  const initial = (actor.name ?? actor.email).trim().charAt(0).toUpperCase();
  return (
    <span
      aria-hidden
      title={actor.email}
      className="flex size-[32px] items-center justify-center rounded-full bg-item-selection type-strong-13 text-foreground-secondary"
    >
      {initial}
    </span>
  );
}

export function AppChrome({
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
    <div className="flex h-dvh flex-col overflow-hidden bg-background-l1">
      <header className="flex h-[60px] shrink-0 items-center justify-between border-b border-solid border-border bg-background-l1 px-[12px] py-[10px]">
        <span className="type-heading-14 text-foreground-primary">Omni Model</span>

        <div className="flex items-center gap-[8px]">
          {status !== null ? (
            status.lastError != null ? (
              <Badge tone="danger">revision rejected</Badge>
            ) : (
              <Badge tone={status.configured ? "success" : "warning"}>
                {status.configured ? `revision ${status.revision ?? "—"}` : "not configured"}
              </Badge>
            )
          ) : null}
          <Button
            size="medium"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </Button>
          <Button size="medium" onClick={signOut}>
            Sign out
          </Button>
          <Avatar actor={actor} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {/* `min-h-0` is what lets the pane scroll instead of growing. */}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background-l2">{children}</main>
      </div>
    </div>
  );
}

/**
 * The sticky Discard / Save Changes bar every configuration screen carries.
 *
 * Its presence is the design's editing model: a screen accumulates edits and
 * commits them together, rather than saving on each control. `dirty` drives both
 * buttons, so a clean screen offers nothing to press.
 */
export function ActionBar({
  dirty,
  busy,
  onDiscard,
  onSave,
}: {
  dirty: boolean;
  busy: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  return (
    <div className="sticky top-0 z-20 flex w-full items-center justify-between border-b border-solid border-border bg-background-l2 p-[12px]">
      <Button onClick={onDiscard} disabled={!dirty || busy}>
        Discard
      </Button>
      <Button variant="primary" onClick={onSave} disabled={!dirty || busy}>
        {busy ? "Saving…" : "Save Changes"}
      </Button>
    </div>
  );
}

/** The authentication screen's column: 720px, centred, 32px vertical padding. */
export function CenteredPane({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-[720px] max-w-full flex-col gap-[24px] px-[12px] py-[32px]">
      {children}
    </div>
  );
}

/** The routing screen's pane: full width, 24px padding. */
export function WidePane({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-[24px] p-[24px]">{children}</div>;
}

/** A screen title: `Heading 20`. */
export function PaneTitle({ children }: { children: ReactNode }) {
  return <h1 className="type-heading-20 w-full text-foreground-primary">{children}</h1>;
}
