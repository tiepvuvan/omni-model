import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeApi, type FakeApi } from "./support/fake-api";
import { renderAt, selectOption, setMultiline } from "./support/render";

let fake: FakeApi;

/** The shape a working deployment has: one user method, nothing layered over it. */
const JWT_ONLY = {
  security: {
    publicPaths: [] as string[],
    requireWriteKey: false,
    userAuth: { type: "jwt", secret: { $secret: "sec-jwt" }, algorithms: ["HS256"] },
    appAuth: { mode: "all" as const, providers: [] as Record<string, unknown>[] },
  },
};

beforeEach(() => {
  fake = createFakeApi({ config: structuredClone(JWT_ONLY) });
  fake.install();
});

/** The card for one method, found by its heading. */
function card(title: string): HTMLElement {
  const section = screen.getByText(title).closest("section");
  if (section === null) throw new Error(`no card for ${title}`);
  return section;
}

/** The `security` block the last save sent. */
function lastSecurity(): {
  userAuth: Record<string, unknown> | null;
  appAuth: { mode: string; providers: Record<string, unknown>[] };
  publicPaths?: string[];
} {
  const calls = fake.callsTo("PUT", "/security");
  const body = calls[calls.length - 1]?.body as { value: ReturnType<typeof lastSecurity> };
  if (body === undefined) throw new Error("nothing was saved to /security");
  return body.value;
}

const save = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => {
    expect(fake.callsTo("PUT", "/security").length).toBeGreaterThan(0);
  });
};

describe("the two layers", () => {
  it("splits the methods by the layer /meta reports, not by a hardcoded list", async () => {
    await renderAt("/authentication");

    // A verifier added to the registry has to land in the right half on its own,
    // which is only true if the screen reads `layer` rather than naming types.
    expect(screen.getByRole("heading", { name: "User Authentication" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "App Authentication" })).toBeInTheDocument();

    // Layer 1 is a single choice: radios, one group.
    for (const title of ["Firebase", "Clerk", "AWS Cognito", "Supabase Auth", "Custom JWT"]) {
      expect(within(card(title)).getByRole("radio")).toBeInTheDocument();
    }
    // Layer 2 is any number: checkboxes.
    for (const title of [
      "Firebase App Check",
      "Cloudflare Turnstile",
      "reCAPTCHA Enterprise",
      "Google Play Integrity",
      "App Attest",
      "DeviceCheck",
    ]) {
      expect(within(card(title)).getByRole("checkbox")).toBeInTheDocument();
    }
  });

  it("marks the configured user method and only that one", async () => {
    await renderAt("/authentication");

    expect(within(card("Custom JWT")).getByRole("radio")).toBeChecked();
    expect(within(card("Firebase")).getByRole("radio")).not.toBeChecked();
    expect(within(card("Clerk")).getByRole("radio")).not.toBeChecked();
    expect(within(card("AWS Cognito")).getByRole("radio")).not.toBeChecked();
    expect(within(card("Supabase Auth")).getByRole("radio")).not.toBeChecked();
  });

  it("shows a method's fields only while it is the chosen one", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    expect(within(card("Firebase")).queryByLabelText(/Project ID/)).toBeNull();
    expect(within(card("Firebase"))).toBeDefined();
    expect(card("Firebase")).toHaveTextContent("Not in use");

    await user.click(within(card("Firebase")).getByRole("radio", { name: "Use Firebase" }));

    expect(await within(card("Firebase")).findByLabelText("Project ID")).toBeInTheDocument();
    // And the one it replaced folds away, since only one can be in use.
    expect(card("Custom JWT")).toHaveTextContent("Not in use");
  });

  it("replaces the user method rather than merging its options", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(within(card("Firebase")).getByRole("radio", { name: "Use Firebase" }));
    await user.type(await within(card("Firebase")).findByLabelText("Project ID"), "my-project");
    await save(user);

    // A jwt secret means nothing to Firebase Auth: carrying options across would
    // submit keys the new factory rejects.
    expect(lastSecurity().userAuth).toEqual({ type: "firebase-auth", projectId: "my-project" });
  });

  it("renders and saves Clerk and AWS Cognito from their published schemas", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(within(card("Clerk")).getByRole("radio", { name: "Use Clerk" }));
    await user.type(
      await within(card("Clerk")).findByLabelText("Issuer"),
      "https://helpful-otter.clerk.accounts.dev",
    );
    await user.type(
      within(card("Clerk")).getByLabelText("Authorized Parties (optional)"),
      "https://app.example.com{Enter}",
    );
    await save(user);
    expect(lastSecurity().userAuth).toEqual({
      type: "clerk",
      issuer: "https://helpful-otter.clerk.accounts.dev",
      authorizedParties: ["https://app.example.com"],
    });

    await user.click(within(card("AWS Cognito")).getByRole("radio", { name: "Use AWS Cognito" }));
    await user.type(await within(card("AWS Cognito")).findByLabelText("Region"), "us-east-1");
    await user.type(
      within(card("AWS Cognito")).getByLabelText("User Pool ID"),
      "us-east-1_Example",
    );
    await user.type(
      within(card("AWS Cognito")).getByLabelText("Client IDs"),
      "app-client-id{Enter}",
    );
    await save(user);
    expect(lastSecurity().userAuth).toEqual({
      type: "aws-cognito",
      region: "us-east-1",
      userPoolId: "us-east-1_Example",
      clientIds: ["app-client-id"],
    });
  });

  it("keeps what is stored for a method when switching away and back", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(within(card("Firebase")).getByRole("radio", { name: "Use Firebase" }));
    await user.click(within(card("Custom JWT")).getByRole("radio", { name: "Use Custom JWT" }));

    // Returning to JWT must not be a way to lose its configuration — and since the
    // draft is back to what is stored, there is correctly nothing to save.
    expect(within(card("Custom JWT")).getByText("HS256")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });

  it("never renders a sealed credential's id", async () => {
    await renderAt("/authentication");

    expect(document.body.textContent).not.toContain("sec-jwt");
  });

  it("says /v1 is closed when no user method is set", async () => {
    // Not an edge case — it is the state a fresh container boots in, and the
    // reason `/v1` answers 503 rather than serving anything.
    fake.state.config = { security: { ...JWT_ONLY.security, userAuth: undefined } };

    await renderAt("/authentication");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No user authentication is set");
    expect(alert).toHaveTextContent("503");
  });

  it("does not treat an app scheme as authentication on its own", async () => {
    // The tempting mistake: attest the app and call it authenticated. The screen
    // has to keep saying `/v1` is closed, because the server refuses to build.
    fake.state.config = {
      security: {
        ...JWT_ONLY.security,
        userAuth: undefined,
        appAuth: { mode: "all", providers: [{ type: "apple-app-attest" }] },
      },
    };

    await renderAt("/authentication");

    expect(await screen.findByRole("alert")).toHaveTextContent("No user authentication is set");
  });
});

describe("the app layer", () => {
  it("enables any number of schemes, and saves them under appAuth", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(
      within(card("Firebase App Check")).getByRole("checkbox", {
        name: "Enable Firebase App Check",
      }),
    );
    await user.click(
      within(card("App Attest")).getByRole("checkbox", { name: "Enable App Attest" }),
    );
    await user.type(await within(card("App Attest")).findByLabelText("Team ID"), "TEAM123");
    await user.type(within(card("App Attest")).getByLabelText("Bundle ID"), "com.example.app");
    await save(user);

    const saved = lastSecurity();
    expect(saved.appAuth.providers.map((entry) => entry.type)).toEqual([
      "firebase-app-check",
      "apple-app-attest",
    ]);
    // And layer 1 is untouched by any of it.
    expect(saved.userAuth).toMatchObject({ type: "jwt" });
  });

  it("renders and saves the new server-verified app schemes", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(
      within(card("Cloudflare Turnstile")).getByRole("checkbox", {
        name: "Enable Cloudflare Turnstile",
      }),
    );
    await user.type(
      await within(card("Cloudflare Turnstile")).findByLabelText("Secret"),
      "turnstile-secret",
    );
    await user.click(
      within(card("reCAPTCHA Enterprise")).getByRole("checkbox", {
        name: "Enable reCAPTCHA Enterprise",
      }),
    );
    await user.type(
      await within(card("reCAPTCHA Enterprise")).findByLabelText("Project ID"),
      "risk-project",
    );
    await user.type(within(card("reCAPTCHA Enterprise")).getByLabelText("Site Key"), "site-key");
    await user.type(within(card("reCAPTCHA Enterprise")).getByLabelText("Expected Action"), "chat");
    await user.type(within(card("reCAPTCHA Enterprise")).getByLabelText("Min Score"), "0.7");
    await save(user);

    expect(lastSecurity().appAuth.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "cloudflare-turnstile", secret: "turnstile-secret" }),
        expect.objectContaining({
          type: "recaptcha-enterprise",
          projectId: "risk-project",
          siteKey: "site-key",
          expectedAction: "chat",
          minScore: 0.7,
        }),
      ]),
    );
  });

  it("chooses how several schemes combine, and explains the choice", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    // `all` is the default and the right answer for one platform layering two
    // schemes; `any` is the right answer for several platforms.
    expect(screen.getByText(/Every enabled scheme must accept/)).toBeInTheDocument();

    await selectOption(user, /more than one is enabled/i, /any one of them/);
    await save(user);

    expect(lastSecurity().appAuth.mode).toBe("any");
    expect(screen.getByText(/first enabled scheme that accepts wins/)).toBeInTheDocument();
  });

  it("keeps a disabled scheme's stored options when it is re-enabled", async () => {
    fake.state.config = {
      security: {
        ...JWT_ONLY.security,
        appAuth: {
          mode: "all",
          providers: [{ type: "apple-device-check", teamId: "TEAM123", keyId: "KEY123" }],
        },
      },
    };
    const user = userEvent.setup();
    await renderAt("/authentication");

    const box = within(card("DeviceCheck")).getByRole("checkbox");
    await user.click(box);
    await user.click(box);

    // Unticking is not a way to lose a configuration: the fields come back filled,
    // and the draft matches what is stored, so there is nothing to save.
    expect(await within(card("DeviceCheck")).findByLabelText("Team ID")).toHaveValue("TEAM123");
    expect(within(card("DeviceCheck")).getByLabelText("Key ID")).toHaveValue("KEY123");
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });
});

describe("editing", () => {
  it("commits nothing until Save Changes", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(within(card("Firebase")).getByRole("radio", { name: "Use Firebase" }));

    expect(fake.callsTo("PUT", "/security")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
  });

  it("leaves Save Changes inert until something changes", async () => {
    await renderAt("/authentication");

    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });

  it("discards back to what is stored", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(within(card("Firebase")).getByRole("radio", { name: "Use Firebase" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(within(card("Custom JWT")).getByRole("radio")).toBeChecked();
    expect(within(card("Firebase")).getByRole("radio")).not.toBeChecked();
  });

  it("keeps the sealed secret when the field is left blank", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    const secret = within(card("Custom JWT")).getByLabelText("Secret (optional)");
    // There is no endpoint that returns plaintext, so the box is empty and the
    // placeholder carries the meaning.
    expect(secret).toHaveValue("");
    expect(secret).toHaveAttribute("placeholder", expect.stringContaining("leave blank to keep"));

    await user.type(
      within(card("Custom JWT")).getByLabelText("Issuer (optional)"),
      "https://issuer.test",
    );
    await save(user);

    // Dropping the key would delete the credential; sending "" would fail the
    // factory's own validation. Sending the reference back is the only correct move.
    expect(lastSecurity().userAuth).toMatchObject({
      secret: { $secret: "sec-jwt" },
      issuer: "https://issuer.test",
    });
  });

  it("replaces the secret when a new one is typed", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.type(
      within(card("Custom JWT")).getByLabelText("Secret (optional)"),
      "a-rotated-secret",
    );
    await save(user);

    expect(lastSecurity().userAuth?.secret).toBe("a-rotated-secret");
  });

  it("sends a list option as an array of chips", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    const algorithms = within(card("Custom JWT")).getByLabelText("Algorithms (optional)");
    // The stored value renders as a chip, and a new one commits on Enter.
    expect(within(card("Custom JWT")).getByText("HS256")).toBeInTheDocument();
    await user.type(algorithms, "HS384{Enter}");
    await save(user);

    expect(lastSecurity().userAuth?.algorithms).toEqual(["HS256", "HS384"]);
  });

  it("removes a chip individually", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(within(card("Custom JWT")).getByRole("button", { name: "Remove HS256" }));
    await save(user);

    expect("algorithms" in (lastSecurity().userAuth ?? {})).toBe(false);
  });

  it("shows why a rejected change was rejected", async () => {
    fake.state.rejectSave = "security.userAuth: jwt requires either secret or jwksUrl";
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.type(within(card("Custom JWT")).getByLabelText("Issuer (optional)"), "x");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(await screen.findByText(/requires either secret or jwksUrl/)).toBeInTheDocument();
  });
});

describe("the sidebar", () => {
  it("lists the sections the design shows, disabling the ones with no screen", async () => {
    await renderAt("/authentication");

    const nav = within(screen.getByRole("navigation", { name: "Sections" }));
    for (const label of ["Authentication", "Routing", "Rate Limit", "Logs", "Settings"]) {
      expect(nav.getByRole("link", { name: label })).toBeInTheDocument();
    }
    // Present but not yet built: dropping them would make the built screens look
    // like the whole product.
    expect(nav.getByText("Users")).toHaveAttribute("aria-disabled");
    expect(nav.getByText("Admin")).toBeInTheDocument();
  });
});

describe("public paths", () => {
  it("preserves them across a save that does not touch them", async () => {
    // Not on the Figma screen, but the block cannot be written without them: a
    // whole-block PUT that omitted `publicPaths` would silently clear them.
    const user = userEvent.setup();
    fake.state.config = { security: { ...JWT_ONLY.security, publicPaths: ["/keep"] } };
    await renderAt("/authentication");

    await user.type(within(card("Custom JWT")).getByLabelText("Issuer (optional)"), "x");
    await save(user);

    expect(lastSecurity().publicPaths).toEqual(["/keep"]);
    expect(setMultiline).toBeTypeOf("function");
  });
});
