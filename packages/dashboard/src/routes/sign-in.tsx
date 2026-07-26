import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthCard } from "../components/auth-card";
import { Button, Callout, TextField } from "../components/ui/primitives";
import { ApiError, api } from "../lib/api";

/**
 * Sign in — `/auth` in the design.
 *
 * The loader redirects to `/setup` when the deployment has no accounts yet: a
 * password form is useless before an account exists, and the first-run path is
 * open exactly once.
 */
export const Route = createFileRoute("/sign-in")({
  loader: async () => {
    const setup = await api.setup().catch(() => ({ needsFirstOperator: false, operators: 0 }));
    if (setup.needsFirstOperator) throw redirect({ to: "/setup" });
    return null;
  },
  component: SignIn,
});

function SignIn() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.signIn(email, password);
      await navigate({ to: "/routing" });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? // Better Auth answers 401 for a wrong password *and* an unknown
            // address, deliberately — echoing which one it was would confirm
            // whether an address has an account here.
            caught.status === 401
            ? "That email and password combination is not correct."
            : caught.message
          : "Something went wrong signing in.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Welcome back" onSubmit={submit}>
      {error !== null ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}

      <TextField
        label="Email"
        type="email"
        name="email"
        autoComplete="username"
        required
        placeholder="jane@company.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <TextField
        label="Password"
        type="password"
        name="password"
        autoComplete="current-password"
        required
        placeholder="Your password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />

      <Button type="submit" variant="primary" disabled={busy} className="w-full">
        {busy ? "Signing in…" : "Sign In"}
      </Button>
    </AuthCard>
  );
}
