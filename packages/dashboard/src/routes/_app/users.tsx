import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import copyIcon from "../../assets/copy.svg";
import plusIcon from "../../assets/plus.svg";
import { Button, Callout, cx, Modal, TextField, ThemedIcon } from "../../components/ui/primitives";
import { api, type CreatedTeamInvite, type TeamInvite, type TeamUser } from "../../lib/api";

export const Route = createFileRoute("/_app/users")({
  loader: () => api.team(),
  component: UsersScreen,
});

function date(value: number): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function MembersTable({ users }: { users: TeamUser[] }) {
  const cell = "h-[44px] border-b border-solid border-border px-[12px] text-left align-middle";
  return (
    <table aria-label="Team members" className="w-full table-fixed">
      <thead>
        <tr>
          {["Name", "Email", "Role", "Joined"].map((heading) => (
            <th
              key={heading}
              scope="col"
              className={cx(cell, "type-strong-14 text-foreground-primary")}
            >
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {users.map((member) => (
          <tr key={member.id}>
            <td className={cx(cell, "type-copy-14 text-foreground-primary")}>{member.name}</td>
            <td className={cx(cell, "type-copy-14 text-foreground-primary")}>{member.email}</td>
            <td className={cx(cell, "type-copy-14 capitalize text-foreground-secondary")}>
              {member.role ?? "member"}
            </td>
            <td className={cx(cell, "type-copy-14 text-foreground-secondary")}>
              {date(member.createdAt)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InvitesTable({
  invites,
  busyId,
  onRevoke,
}: {
  invites: TeamInvite[];
  busyId: string | null;
  onRevoke: (invite: TeamInvite) => void;
}) {
  if (invites.length === 0) {
    return (
      <p className="border-b border-solid border-border px-[24px] py-[24px] type-copy-14 text-foreground-secondary">
        No pending invitations.
      </p>
    );
  }

  const cell = "h-[44px] border-b border-solid border-border px-[12px] text-left align-middle";
  return (
    <table aria-label="Pending invitations" className="w-full table-fixed">
      <thead>
        <tr>
          {["Email", "Invited by", "Expires", "Actions"].map((heading) => (
            <th
              key={heading}
              scope="col"
              className={cx(cell, "type-strong-14 text-foreground-primary")}
            >
              {heading === "Actions" ? <span className="sr-only">{heading}</span> : heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {invites.map((invite) => (
          <tr key={invite.id}>
            <td className={cx(cell, "type-copy-14 text-foreground-primary")}>{invite.email}</td>
            <td className={cx(cell, "type-copy-14 text-foreground-secondary")}>
              {invite.invitedBy}
            </td>
            <td className={cx(cell, "type-copy-14 text-foreground-secondary")}>
              {date(invite.expiresAt)}
            </td>
            <td className={cell}>
              <Button
                size="medium"
                disabled={busyId === invite.id}
                onClick={() => onRevoke(invite)}
              >
                {busyId === invite.id ? "Revoking…" : "Revoke"}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UsersScreen() {
  const team = Route.useLoaderData();
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<CreatedTeamInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setEmail("");
    setCreated(null);
    setCopied(false);
    setError(null);
  };

  const create = async () => {
    const address = email.trim();
    if (address === "") {
      setError("Enter your teammate's email.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.createTeamInvite(address);
      setCreated(result);
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The invitation could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (created === null) return;
    try {
      await navigator.clipboard.writeText(created.link);
      setCopied(true);
    } catch {
      setError("The browser could not copy the link. Select and copy it manually.");
    }
  };

  const revoke = async (invite: TeamInvite) => {
    if (!window.confirm(`Revoke the invitation for ${invite.email}?`)) return;
    setBusyId(invite.id);
    setError(null);
    try {
      await api.revokeTeamInvite(invite.id);
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The invitation could not be revoked.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <section className="flex items-start justify-between gap-[32px] border-b border-solid border-border px-[24px] py-[32px]">
        <div className="flex w-[580px] max-w-full flex-col gap-[6px]">
          <h1 className="type-heading-20 text-foreground-primary">Users</h1>
          <p className="type-copy-14 text-foreground-secondary">
            Invite teammates to manage this deployment. Links are bound to one email, expire after
            seven days, and can be used only once.
          </p>
        </div>
        <Button
          variant="primary"
          icon={plusIcon}
          onClick={() => {
            reset();
            setDialogOpen(true);
          }}
        >
          Invite team member
        </Button>
      </section>

      {error !== null && !dialogOpen ? (
        <div className="p-[24px]">
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        </div>
      ) : null}

      <section aria-labelledby="members-heading">
        <h2
          id="members-heading"
          className="border-b border-solid border-border px-[24px] py-[16px] type-strong-14 text-foreground-primary"
        >
          Team members
        </h2>
        <div className="overflow-x-auto">
          <MembersTable users={team.users} />
        </div>
      </section>

      <section aria-labelledby="invites-heading" className="mt-[24px]">
        <h2
          id="invites-heading"
          className="border-y border-solid border-border px-[24px] py-[16px] type-strong-14 text-foreground-primary"
        >
          Pending invitations
        </h2>
        <div className="overflow-x-auto">
          <InvitesTable invites={team.invites} busyId={busyId} onRevoke={revoke} />
        </div>
      </section>

      <Modal
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) reset();
        }}
        title="Invite team member"
        description="Generate a one-time link and send it to the email below."
      >
        <TextField
          label="Email"
          type="email"
          placeholder="teammate@company.com"
          value={email}
          disabled={created !== null}
          autoFocus
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && created === null && !busy) void create();
          }}
        />

        {created !== null ? (
          <div className="flex flex-col gap-[8px]">
            <span className="type-strong-13 text-foreground-primary">Invitation link</span>
            <div className="flex items-center gap-[6px] rounded-[var(--radius-field)] border border-solid border-border bg-input-background p-[10px]">
              <code className="min-w-0 flex-1 select-all truncate type-mono-12 text-foreground-primary">
                {created.link}
              </code>
              <button
                type="button"
                onClick={copy}
                className="flex shrink-0 items-center gap-[4px] py-[4px] type-strong-12 text-accent-primary"
              >
                <ThemedIcon src={copyIcon} className="size-[14px]" />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="type-label-12 text-foreground-secondary">
              Send this link to {created.invite.email}. It will not work for another email and
              cannot be shown again after this dialog closes.
            </p>
          </div>
        ) : null}

        {error !== null ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}

        <div className="-mx-[16px] -mb-[16px] flex justify-end border-t border-solid border-border p-[12px]">
          {created === null ? (
            <Button variant="primary" disabled={busy} onClick={create}>
              {busy ? "Generating…" : "Generate invite link"}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => {
                setDialogOpen(false);
                reset();
              }}
            >
              Done
            </Button>
          )}
        </div>
      </Modal>
    </>
  );
}
