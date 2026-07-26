import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeApi, type FakeApi } from "./support/fake-api";
import { renderAt, selectOption, setMultiline } from "./support/render";

let fake: FakeApi;

const ONE_VERIFIER = {
  security: {
    mode: "all" as const,
    publicPaths: [] as string[],
    requireWriteKey: false,
    providers: [{ type: "jwt", secret: { $secret: "sec-jwt" }, algorithms: ["HS256"] }],
  },
};

beforeEach(() => {
  fake = createFakeApi({ config: structuredClone(ONE_VERIFIER) });
  fake.install();
});

/** The card for one vendor, found by its heading. */
function card(title: string): HTMLElement {
  const section = screen.getByText(title).closest("section");
  if (section === null) throw new Error(`no card for ${title}`);
  return section;
}

/** The `security` block the last save sent. */
function lastSecurity(): Record<string, unknown> {
  const calls = fake.callsTo("PUT", "/security");
  const body = calls[calls.length - 1]?.body as { value: Record<string, unknown> } | undefined;
  if (body === undefined) throw new Error("nothing was saved to /security");
  return body.value;
}

const save = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => {
    expect(fake.callsTo("PUT", "/security").length).toBeGreaterThan(0);
  });
};

describe("the vendor cards", () => {
  it("lists every method the design draws, enabled or not", async () => {
    await renderAt("/authentication");

    // The design shows all five as cards with a checkbox rather than only the
    // configured ones — the screen is the menu of what the proxy can check.
    for (const title of ["Firebase", "Supabase Auth", "Custom JWT", "App Attest", "DeviceCheck"]) {
      expect(card(title)).toBeInTheDocument();
    }
  });

  it("ticks the box for a configured method and not the others", async () => {
    await renderAt("/authentication");

    expect(
      within(card("Custom JWT")).getByRole("checkbox", { name: "Enable Custom JWT" }),
    ).toBeChecked();
    expect(
      within(card("Supabase Auth")).getByRole("checkbox", { name: "Enable Supabase Auth" }),
    ).not.toBeChecked();
  });

  it("shows a disabled method's fields only once it is enabled", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    expect(within(card("Supabase Auth")).getByText(/Not enabled/)).toBeInTheDocument();

    await user.click(
      within(card("Supabase Auth")).getByRole("checkbox", { name: "Enable Supabase Auth" }),
    );

    // The fields come from the verifier's own published schema.
    expect(await within(card("Supabase Auth")).findByLabelText("JWKS URL")).toBeInTheDocument();
  });

  it("never renders a sealed credential's id", async () => {
    await renderAt("/authentication");

    expect(document.body.textContent).not.toContain("sec-jwt");
  });

  it("says /v1 is closed when nothing is enabled", async () => {
    // Not an edge case — it is the state a fresh container boots in, and the
    // reason `/v1` answers 503 rather than serving anything.
    fake.state.config = { security: { ...ONE_VERIFIER.security, providers: [] } };

    await renderAt("/authentication");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No verifier is enabled");
    expect(alert).toHaveTextContent("503");
  });
});

describe("the Firebase card", () => {
  it("puts App Check behind its own checkbox inside the Firebase card", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(within(card("Firebase")).getByRole("checkbox", { name: "Enable Firebase" }));

    const appCheck = await within(card("Firebase")).findByRole("checkbox", {
      name: "Enable App Check",
    });
    expect(appCheck).not.toBeChecked();

    await user.click(appCheck);

    // App Check is a second verifier, not a Firebase Auth option — so enabling it
    // has to add an entry rather than set a flag.
    expect(await within(card("Firebase")).findByLabelText("Project Number")).toBeInTheDocument();
    await save(user);
    const providers = lastSecurity().providers as { type: string }[];
    expect(providers.map((provider) => provider.type)).toContain("firebase-auth");
    expect(providers.map((provider) => provider.type)).toContain("firebase-app-check");
  });
});

describe("editing", () => {
  it("commits nothing until Save Changes", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(
      within(card("Supabase Auth")).getByRole("checkbox", { name: "Enable Supabase Auth" }),
    );

    // The design's editing model: a screen accumulates edits and one button
    // commits them. A per-control save would have to persist an enabled verifier
    // with no options, which the API would rightly reject.
    expect(fake.callsTo("PUT", "/security")).toHaveLength(0);

    await save(user);
    const providers = lastSecurity().providers as { type: string }[];
    expect(providers.map((provider) => provider.type)).toEqual(["jwt", "supabase"]);
  });

  it("leaves Save Changes inert until something changes", async () => {
    await renderAt("/authentication");

    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });

  it("discards back to what is stored", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(
      within(card("Supabase Auth")).getByRole("checkbox", { name: "Enable Supabase Auth" }),
    );
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(
      within(card("Supabase Auth")).getByRole("checkbox", { name: "Enable Supabase Auth" }),
    ).not.toBeChecked();
    expect(fake.callsTo("PUT", "/security")).toHaveLength(0);
  });

  it("keeps the sealed secret when the field is left blank", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    const secret = within(card("Custom JWT")).getByLabelText("Secret");
    // There is no endpoint that returns plaintext, so the box is empty and the
    // placeholder carries the meaning.
    expect(secret).toHaveValue("");
    expect(secret).toHaveAttribute("placeholder", expect.stringContaining("leave blank to keep"));

    await user.type(within(card("Custom JWT")).getByLabelText("Issuer"), "https://issuer.test");
    await save(user);

    const providers = lastSecurity().providers as Record<string, unknown>[];
    // Dropping the key would delete the credential; sending "" would fail the
    // factory's own validation. Sending the reference back is the only correct move.
    expect(providers[0]?.secret).toEqual({ $secret: "sec-jwt" });
    expect(providers[0]?.issuer).toBe("https://issuer.test");
  });

  it("replaces the secret when a new one is typed", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.type(within(card("Custom JWT")).getByLabelText("Secret"), "a-rotated-secret");
    await save(user);

    const providers = lastSecurity().providers as Record<string, unknown>[];
    expect(providers[0]?.secret).toBe("a-rotated-secret");
  });

  it("sends a list option as an array of chips", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    const algorithms = within(card("Custom JWT")).getByLabelText("Algorithms");
    // The stored value renders as a chip, and a new one commits on Enter.
    expect(within(card("Custom JWT")).getByText("HS256")).toBeInTheDocument();
    await user.type(algorithms, "HS384{Enter}");
    await save(user);

    const providers = lastSecurity().providers as Record<string, unknown>[];
    expect(providers[0]?.algorithms).toEqual(["HS256", "HS384"]);
  });

  it("removes a chip individually", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(within(card("Custom JWT")).getByRole("button", { name: "Remove HS256" }));
    await save(user);

    const providers = lastSecurity().providers as Record<string, unknown>[];
    expect("algorithms" in (providers[0] ?? {})).toBe(false);
  });

  it("shows why a rejected change was rejected", async () => {
    fake.state.rejectSave = "security.providers[0]: jwt requires either secret or jwksUrl";
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.type(within(card("Custom JWT")).getByLabelText("Issuer"), "x");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(await screen.findByText(/requires either secret or jwksUrl/)).toBeInTheDocument();
  });
});

describe("match mode", () => {
  it("changes the mode", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await selectOption(user, /match mode/i, /any of following/);
    await save(user);

    expect(lastSecurity().mode).toBe("any");
  });

  it("explains what the mode means", async () => {
    await renderAt("/authentication");

    expect(
      screen.getByText(/must pass all of these enabled authentication methods/),
    ).toBeInTheDocument();
  });
});

describe("the sidebar", () => {
  it("lists the sections the design shows, disabling the ones with no screen", async () => {
    await renderAt("/authentication");

    const nav = within(screen.getByRole("navigation", { name: "Sections" }));
    expect(nav.getByRole("link", { name: "Authentication" })).toBeInTheDocument();
    expect(nav.getByRole("link", { name: "Routing" })).toBeInTheDocument();
    // Present but not yet built: dropping them would make the two built screens
    // look like the whole product.
    for (const label of ["Rate Limit", "Logs", "Users", "Settings"]) {
      expect(nav.getByText(label)).toHaveAttribute("aria-disabled");
    }
    expect(nav.getByText("Admin")).toBeInTheDocument();
  });
});

describe("public paths", () => {
  it("saves them one per line", async () => {
    // Not on the Figma screen, but the block cannot be written without them: a
    // whole-block PUT that omitted `publicPaths` would silently clear them.
    const user = userEvent.setup();
    fake.state.config = {
      security: { ...ONE_VERIFIER.security, publicPaths: ["/keep"] },
    };
    await renderAt("/authentication");

    await user.type(within(card("Custom JWT")).getByLabelText("Issuer"), "x");
    await save(user);

    expect(lastSecurity().publicPaths).toEqual(["/keep"]);
    expect(setMultiline).toBeTypeOf("function");
  });
});
