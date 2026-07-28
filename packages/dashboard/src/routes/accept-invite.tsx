import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthCard } from "../components/auth-card";
import { Button, Callout, TextField } from "../components/ui/primitives";
import { api } from "../lib/api";

const MIN_PASSWORD = 8;

export const Route = createFileRoute("/accept-invite")({
  validateSearch: (search: Record<string, unknown>): { token: string } => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ deps }) => {
    if (deps.token === "") return null;
    return api.teamInvite(deps.token).catch(() => null);
  },
  component: AcceptInvite,
});

function AcceptInvite() {
  const invite = Route.useLoaderData();
  const { token } = Route.useSearch();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm !== "" && confirm !== password;
  const tooShort = password !== "" && password.length < MIN_PASSWORD;
  const incomplete = password.length < MIN_PASSWORD || confirm !== password;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (invite === null || incomplete) return;
    setBusy(true);
    setError(null);
    try {
      await api.acceptTeamInvite(token, password, name.trim() || undefined);
      setAccepted(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The invitation could not be accepted.");
    } finally {
      setBusy(false);
    }
  };

  if (invite === null) {
    return (
      <AuthCard title="Invitation unavailable" onSubmit={(event) => event.preventDefault()}>
        <Callout tone="danger" role="alert">
          This invitation is invalid, expired, revoked, or has already been used.
        </Callout>
        <Button type="button" variant="primary" onClick={() => void navigate({ to: "/sign-in" })}>
          Go to sign in
        </Button>
      </AuthCard>
    );
  }

  if (accepted) {
    return (
      <AuthCard title="Welcome to the team" onSubmit={(event) => event.preventDefault()}>
        <Callout tone="success" role="status">
          Your account for {invite.email} is ready.
        </Callout>
        <Button type="button" variant="primary" onClick={() => void navigate({ to: "/sign-in" })}>
          Sign in
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Join your team"
      onSubmit={submit}
      footer={`This invitation for ${invite.email} expires ${new Date(
        invite.expiresAt,
      ).toLocaleDateString()}.`}
    >
      {error !== null ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}
      <TextField label="Email" type="email" value={invite.email} disabled />
      <TextField
        label="Name"
        autoComplete="name"
        placeholder="Your name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        error={tooShort ? `Use at least ${MIN_PASSWORD} characters.` : null}
      />
      <TextField
        label="Re-enter Password"
        type="password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        error={mismatch ? "The two passwords do not match." : null}
      />
      <Button type="submit" variant="primary" disabled={busy || incomplete}>
        {busy ? "Joining…" : "Join team"}
      </Button>
    </AuthCard>
  );
}
