import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeApi, type FakeApi } from "./support/fake-api";
import { currentPath, renderAt } from "./support/render";

let fake: FakeApi;

beforeEach(() => {
  fake = createFakeApi();
  fake.install();
});

describe("the session guard", () => {
  it("sends a signed-out visitor to sign in", async () => {
    fake.state.signedIn = false;

    const { router } = await renderAt("/routing");

    expect(currentPath(router)).toBe("/sign-in");
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
  });

  it("sends a signed-out visitor to setup instead when no account exists", async () => {
    // The distinction that matters: a sign-in form is a dead end on a deployment
    // that has never had an operator, because there is nothing to sign in to.
    fake.state.signedIn = false;
    fake.state.operators = 0;

    const { router } = await renderAt("/routing");

    expect(currentPath(router)).toBe("/setup");
    expect(await screen.findByRole("heading", { name: "Admin Setup" })).toBeInTheDocument();
  });

  it("does not fetch configuration for a signed-out visitor", async () => {
    fake.state.signedIn = false;

    await renderAt("/routing");

    // A guard that redirected *after* loading would show a page full of 401s.
    expect(fake.callsTo("GET", "/config")).toHaveLength(0);
  });

  it("lets a signed-in operator through to the screen", async () => {
    const { router } = await renderAt("/routing");

    expect(currentPath(router)).toBe("/routing");
    // The design gives this screen no title, so its own control is the anchor.
    expect(await screen.findByRole("button", { name: "Matching Rule" })).toBeInTheDocument();
  });

  it("shows the operator email without a healthy revision badge", async () => {
    await renderAt("/routing");

    const header = screen.getByText("ops@example.test").closest("header");
    if (header === null) throw new Error("operator email is not in the application header");
    expect(within(header).getByText("ops@example.test")).toBeInTheDocument();
    expect(header).not.toHaveTextContent(/revision\s+\d+/i);
  });

  it("renders navigation glyphs as theme-aware masks", async () => {
    await renderAt("/routing");

    const authentication = screen.getByRole("link", { name: "Authentication" });
    const icon = authentication.querySelector<HTMLElement>("span[style*='mask-image']");
    expect(icon).not.toBeNull();
    expect(icon).toHaveClass("bg-current");
  });
});

describe("sign in", () => {
  beforeEach(() => {
    fake.state.signedIn = false;
  });

  it("signs in and lands on routing", async () => {
    const user = userEvent.setup();
    const { router } = await renderAt("/sign-in");

    await user.type(screen.getByLabelText("Email"), "ops@example.test");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    // The design gives this screen no title, so its own control is the anchor.
    expect(await screen.findByRole("button", { name: "Matching Rule" })).toBeInTheDocument();
    expect(currentPath(router)).toBe("/routing");
  });

  it("reports a rejected password without saying which half was wrong", async () => {
    const user = userEvent.setup();
    await renderAt("/sign-in");

    await user.type(screen.getByLabelText("Email"), "ops@example.test");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That email and password combination is not correct.");
    // Confirming that an address has an account here would be an enumeration
    // oracle, so neither the API nor this screen distinguishes the two cases.
    expect(alert.textContent).not.toContain("password is");
    expect(alert.textContent).not.toContain("no account");
  });

  it("redirects to setup when the deployment has no operator yet", async () => {
    fake.state.operators = 0;

    const { router } = await renderAt("/sign-in");

    expect(currentPath(router)).toBe("/setup");
  });
});

describe("first-run setup", () => {
  beforeEach(() => {
    fake.state.signedIn = false;
    fake.state.operators = 0;
  });

  it("creates the first operator and lands signed in", async () => {
    const user = userEvent.setup();
    const { router } = await renderAt("/setup");

    await user.type(screen.getByLabelText("Email"), "ops@example.test");
    await user.type(screen.getByLabelText("Password"), "a long test passphrase");
    await user.type(screen.getByLabelText("Re-enter Password"), "a long test passphrase");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // The design gives this screen no title, so its own control is the anchor.
    expect(await screen.findByRole("button", { name: "Matching Rule" })).toBeInTheDocument();
    expect(currentPath(router)).toBe("/routing");
    // Sign-up establishes the session, so there must be no sign-in round trip.
    expect(fake.callsTo("POST", "/auth/sign-in/email")).toHaveLength(0);
  });

  it("refuses to submit mismatched passwords", async () => {
    const user = userEvent.setup();
    await renderAt("/setup");

    await user.type(screen.getByLabelText("Email"), "ops@example.test");
    await user.type(screen.getByLabelText("Password"), "a long test passphrase");
    await user.type(screen.getByLabelText("Re-enter Password"), "a long test passphrasf");

    expect(await screen.findByText("The two passwords do not match.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(fake.callsTo("POST", "/auth/sign-up/email")).toHaveLength(0);
  });

  it("refuses a password shorter than the server's minimum", async () => {
    const user = userEvent.setup();
    await renderAt("/setup");

    await user.type(screen.getByLabelText("Password"), "short");

    expect(await screen.findByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("is closed once an account exists", async () => {
    // The first-run window is the only thing between a public port and a config
    // API, so it closes on the server's answer rather than on anything local.
    fake.state.operators = 1;

    const { router } = await renderAt("/setup");

    expect(currentPath(router)).toBe("/sign-in");
  });
});

describe("sign out", () => {
  it("ends the session and returns to sign in", async () => {
    const user = userEvent.setup();
    const { router } = await renderAt("/routing");

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(fake.callsTo("POST", "/auth/sign-out")).toHaveLength(1);
    expect(currentPath(router)).toBe("/sign-in");
  });
});
