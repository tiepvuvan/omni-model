import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthCard } from "../components/auth-card";
import { Button, Callout, TextField } from "../components/ui/primitives";
import { ApiError, api } from "../lib/api";

/** Better Auth's own minimum; saying so up front beats a 422 after submitting. */
const MIN_PASSWORD = 8;

/**
 * First-run: create the operator account.
 *
 * Reachable only while the deployment has zero accounts. That window is the only
 * thing between an open port and a configuration API, so the loader closes the
 * screen the moment an account exists rather than relying on the form failing.
 */
export const Route = createFileRoute("/setup")({
  loader: async () => {
    const setup = await api.setup();
    if (!setup.needsFirstOperator) throw redirect({ to: "/sign-in" });
    return setup;
  },
  component: Setup,
});

function Setup() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm !== "" && confirm !== password;
  const tooShort = password !== "" && password.length < MIN_PASSWORD;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (mismatch || tooShort) return;
    setError(null);
    setBusy(true);
    try {
      await api.signUp(email, password, name);
      // Sign-up establishes the session, so there is nothing to sign in to.
      await navigate({ to: "/routing" });
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Something went wrong creating the account.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Create the first operator"
      subtitle="This deployment has no accounts yet. The account you create here is granted the operator role."
      onSubmit={submit}
      footer="Sign-up closes permanently once this account exists. Use the create-admin command to add operators after that."
    >
      {error !== null ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}

      <TextField
        label="Name"
        name="name"
        autoComplete="name"
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <TextField
        label="Email"
        type="email"
        name="email"
        autoComplete="username"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <TextField
        label="Password"
        type="password"
        name="new-password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        error={tooShort ? `Use at least ${MIN_PASSWORD} characters.` : null}
        hint="A passphrase is easier to remember and harder to guess than a short password."
      />
      <TextField
        label="Confirm password"
        type="password"
        name="confirm-password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        error={mismatch ? "The two passwords do not match." : null}
      />

      <Button
        type="submit"
        variant="primary"
        disabled={busy || mismatch || tooShort}
        className="mt-1 w-full"
      >
        {busy ? "Creating…" : "Create operator"}
      </Button>
    </AuthCard>
  );
}
