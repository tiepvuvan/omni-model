import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamInvite, TeamUser } from "../src/lib/api";
import { createFakeApi, type FakeApi } from "./support/fake-api";
import { dialog, renderAt } from "./support/render";

const member: TeamUser = {
  id: "u-root",
  email: "root@example.test",
  name: "Root Operator",
  role: "admin",
  createdAt: Date.UTC(2026, 0, 1),
};

const pending: TeamInvite = {
  id: "invite-1",
  email: "pending@example.test",
  invitedBy: "root@example.test",
  createdAt: Date.UTC(2026, 0, 2),
  expiresAt: Date.UTC(2026, 0, 9),
};

describe("users", () => {
  let fake: FakeApi;

  beforeEach(() => {
    fake = createFakeApi({ users: [member], invites: [] });
    fake.install();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lists team members and pending invitations", async () => {
    fake.state.invites = [pending];
    await renderAt("/users");

    const members = screen.getByRole("table", { name: "Team members" });
    expect(within(members).getByText("Root Operator")).toBeInTheDocument();
    expect(within(members).getByText("root@example.test")).toBeInTheDocument();

    const invitations = screen.getByRole("table", { name: "Pending invitations" });
    expect(within(invitations).getByText("pending@example.test")).toBeInTheDocument();
    expect(within(invitations).getByText("root@example.test")).toBeInTheDocument();
  });

  it("generates and copies an email-bound invitation link", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await renderAt("/users");

    await user.click(screen.getByRole("button", { name: "Invite team member" }));
    const panel = dialog();
    await user.type(panel.getByLabelText("Email"), "Teammate@Example.test");
    await user.click(panel.getByRole("button", { name: "Generate invite link" }));

    const link = "http://admin.test/admin/accept-invite?token=token-invite-1";
    expect(await panel.findByText(link)).toBeInTheDocument();
    expect(fake.callsTo("POST", "/users/invites")).toEqual([
      expect.objectContaining({ body: { email: "Teammate@Example.test" } }),
    ]);
    await user.click(panel.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(link);

    await user.click(panel.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("teammate@example.test")).toBeInTheDocument();
    expect(screen.queryByText(link)).not.toBeInTheDocument();
  });

  it("revokes a pending invitation after confirmation", async () => {
    fake.state.invites = [pending];
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const user = userEvent.setup();
    await renderAt("/users");

    await user.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(fake.callsTo("DELETE", "/users/invites/invite-1")).toHaveLength(1);
    });
    expect(screen.getByText("No pending invitations.")).toBeInTheDocument();
  });

  it("accepts a valid link without an existing session", async () => {
    fake.state.invites = [pending];
    fake.state.signedIn = false;
    const user = userEvent.setup();
    await renderAt("/accept-invite?token=token-invite-1");

    expect(screen.getByLabelText("Email")).toHaveValue("pending@example.test");
    await user.type(screen.getByLabelText("Name"), "Pending Member");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Re-enter Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Join team" }));

    expect(await screen.findByRole("heading", { name: "Welcome to the team" })).toBeInTheDocument();
    expect(fake.callsTo("POST", "/invites/token-invite-1/accept")).toEqual([
      expect.objectContaining({
        body: { name: "Pending Member", password: "correct horse battery staple" },
      }),
    ]);
    expect(fake.state.invites).toHaveLength(0);
    expect(fake.state.users.at(-1)).toMatchObject({
      email: "pending@example.test",
      role: "admin",
    });
  });

  it("shows a safe unavailable state for a bad link", async () => {
    fake.state.signedIn = false;
    await renderAt("/accept-invite?token=not-real");

    expect(screen.getByRole("heading", { name: "Invitation unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("invalid, expired, revoked");
  });
});
