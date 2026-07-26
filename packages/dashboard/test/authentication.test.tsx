import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeApi, type FakeApi } from "./support/fake-api";
import { dialog, renderAt, selectOption, setMultiline } from "./support/render";

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

/** The `<li>` for one verifier. */
function verifierRow(label: string): HTMLElement {
  const row = screen.getByText(label).closest("li");
  if (row === null) throw new Error(`no verifier row for ${label}`);
  return row;
}

/** The `security` block the last save sent. */
function lastSecurity(): Record<string, unknown> {
  const calls = fake.callsTo("PUT", "/security");
  const body = calls[calls.length - 1]?.body as { value: Record<string, unknown> } | undefined;
  if (body === undefined) throw new Error("nothing was saved to /security");
  return body.value;
}

describe("the verifier list", () => {
  it("names each verifier and what it checks", async () => {
    await renderAt("/authentication");

    const row = verifierRow("Custom JWT");
    expect(row).toHaveTextContent("jwt");
    // The axis matters: it is what decides whether `mode: "all"` is sensible.
    expect(row).toHaveTextContent("verifies the user");
    expect(within(row).getByText("sealed credential")).toBeInTheDocument();
  });

  it("distinguishes a device verifier from a user verifier", async () => {
    fake.state.config = {
      security: {
        ...ONE_VERIFIER.security,
        providers: [
          { type: "jwt", secret: { $secret: "s" } },
          { type: "firebase-app-check", projectId: "demo" },
        ],
      },
    };

    await renderAt("/authentication");

    expect(verifierRow("Custom JWT")).toHaveTextContent("verifies the user");
    expect(verifierRow("Firebase App Check")).toHaveTextContent("verifies the app");
  });

  it("never renders a sealed credential's id", async () => {
    await renderAt("/authentication");

    expect(document.body.textContent).not.toContain("sec-jwt");
  });

  it("says /v1 is closed when nothing is configured", async () => {
    // Not an edge case — it is the state a fresh container boots in, and the
    // reason `/v1` answers 503 rather than serving anything.
    fake.state.config = { security: { ...ONE_VERIFIER.security, providers: [] } };

    await renderAt("/authentication");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No verifier is configured");
    expect(alert).toHaveTextContent("503");
  });
});

describe("adding a verifier", () => {
  it("builds the entry from the type's own schema", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(screen.getByRole("button", { name: "Add verifier" }));
    // `jwt` is first in the fake registry, so its schema is what renders.
    await user.type(dialog().getByLabelText("Secret"), "a-long-development-secret");
    await user.type(dialog().getByLabelText("Issuer"), "https://issuer.example.test");
    await user.click(screen.getByRole("button", { name: "Add verifier" }));

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/security")).toHaveLength(1);
    });
    const providers = lastSecurity().providers as Record<string, unknown>[];
    expect(providers).toHaveLength(2);
    expect(providers[1]).toMatchObject({
      type: "jwt",
      secret: "a-long-development-secret",
      issuer: "https://issuer.example.test",
    });
  });

  it("opens on jwt rather than the first type alphabetically", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(screen.getByRole("button", { name: "Add verifier" }));

    // The empty state recommends jwt on this same screen; opening the form on an
    // Apple attestation type because it sorts first contradicts that.
    expect(dialog().getByRole("combobox", { name: /type/i })).toHaveTextContent("Custom JWT");
  });

  it("renders a different form for a different type", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(screen.getByRole("button", { name: "Add verifier" }));
    expect(dialog().getByLabelText("Secret")).toBeInTheDocument();

    await selectOption(user, /type/i, "Firebase App Check");

    // Six verifier types with quite different options share one generated form,
    // and this is the assertion that it actually follows the schema rather than
    // rendering a fixed set of fields.
    await waitFor(() => {
      expect(dialog().getByLabelText("Project id")).toBeInTheDocument();
    });
    expect(dialog().queryByLabelText("Secret")).toBeNull();
  });

  it("sends a boolean option as a boolean", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(screen.getByRole("button", { name: "Add verifier" }));
    await selectOption(user, /type/i, "Firebase App Check");
    await waitFor(() => {
      expect(dialog().getByLabelText("Project id")).toBeInTheDocument();
    });
    await user.type(dialog().getByLabelText("Project id"), "demo-project");
    await user.click(dialog().getByRole("switch", { name: "Consume" }));
    await user.click(screen.getByRole("button", { name: "Add verifier" }));

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/security")).toHaveLength(1);
    });
    const providers = lastSecurity().providers as Record<string, unknown>[];
    expect(providers[1]).toMatchObject({
      type: "firebase-app-check",
      projectId: "demo-project",
      consume: true,
    });
  });

  it("sends a list option one entry per line", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(screen.getByRole("button", { name: "Add verifier" }));
    await user.type(dialog().getByLabelText("Secret"), "s");
    setMultiline(dialog().getByLabelText("Algorithms"), "HS256\nHS384");
    await user.click(screen.getByRole("button", { name: "Add verifier" }));

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/security")).toHaveLength(1);
    });
    const providers = lastSecurity().providers as Record<string, unknown>[];
    expect(providers[1]).toMatchObject({ algorithms: ["HS256", "HS384"] });
  });
});

describe("editing a verifier", () => {
  it("keeps the sealed secret when the field is left blank", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(within(verifierRow("Custom JWT")).getByRole("button", { name: "Edit" }));

    const secret = dialog().getByLabelText("Secret");
    expect(secret).toHaveValue("");
    expect(secret).toHaveAttribute("placeholder", expect.stringContaining("leave blank to keep"));

    await user.type(dialog().getByLabelText("Issuer"), "https://new-issuer.test");
    await user.click(screen.getByRole("button", { name: "Save verifier" }));

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/security")).toHaveLength(1);
    });
    const providers = lastSecurity().providers as Record<string, unknown>[];
    expect(providers).toHaveLength(1);
    expect(providers[0]?.secret).toEqual({ $secret: "sec-jwt" });
    expect(providers[0]?.issuer).toBe("https://new-issuer.test");
  });

  it("replaces the secret when a new one is typed", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(within(verifierRow("Custom JWT")).getByRole("button", { name: "Edit" }));
    await user.type(dialog().getByLabelText("Secret"), "a-rotated-secret");
    await user.click(screen.getByRole("button", { name: "Save verifier" }));

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/security")).toHaveLength(1);
    });
    const providers = lastSecurity().providers as Record<string, unknown>[];
    expect(providers[0]?.secret).toBe("a-rotated-secret");
  });
});

describe("removing a verifier", () => {
  it("refuses to remove the last one without a round trip", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(within(verifierRow("Custom JWT")).getByRole("button", { name: "Remove" }));

    // The API would reject this and the previous configuration would keep serving,
    // so the only thing a request would add is latency before the same answer.
    expect(await screen.findByRole("alert")).toHaveTextContent("At least one verifier is required");
    expect(fake.callsTo("PUT", "/security")).toHaveLength(0);
  });

  it("removes one when another remains", async () => {
    fake.state.config = {
      security: {
        ...ONE_VERIFIER.security,
        providers: [
          { type: "jwt", secret: { $secret: "s" } },
          { type: "firebase-app-check", projectId: "demo" },
        ],
      },
    };
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(
      within(verifierRow("Firebase App Check")).getByRole("button", { name: "Remove" }),
    );

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/security")).toHaveLength(1);
    });
    const providers = lastSecurity().providers as Record<string, unknown>[];
    expect(providers).toHaveLength(1);
    expect(providers[0]?.type).toBe("jwt");
  });
});

describe("how requests are checked", () => {
  it("changes the mode", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await selectOption(user, /verifier mode/i, /^any/);

    await waitFor(() => {
      expect(lastSecurity().mode).toBe("any");
    });
  });

  it("warns when every verifier answers the same question but all must pass", async () => {
    // `mode: "all"` with two user verifiers means a client must present both
    // tokens at once, which is almost never what was meant.
    fake.state.config = {
      security: {
        ...ONE_VERIFIER.security,
        mode: "all",
        providers: [
          { type: "jwt", secret: { $secret: "s" } },
          { type: "supabase", jwtSecret: { $secret: "s2" } },
        ],
      },
    };

    await renderAt("/authentication");

    expect(
      await screen.findByText(/Every configured verifier answers the same question/),
    ).toBeInTheDocument();
  });

  it("does not warn when the verifiers answer different questions", async () => {
    fake.state.config = {
      security: {
        ...ONE_VERIFIER.security,
        mode: "all",
        providers: [
          { type: "jwt", secret: { $secret: "s" } },
          { type: "apple-app-attest", teamId: "T" },
        ],
      },
    };

    await renderAt("/authentication");

    expect(screen.queryByText(/answers the same question/)).toBeNull();
  });

  it("toggles the write-key requirement", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(screen.getByRole("switch", { name: "Require a write key" }));

    await waitFor(() => {
      expect(lastSecurity().requireWriteKey).toBe(true);
    });
  });

  it("says what turning the write-key requirement on will do", async () => {
    await renderAt("/authentication");

    // Said before the toggle is flipped, not after: turning it on locks out every
    // client that is not already sending the header.
    expect(screen.getByText(/locks out any client not already sending one/)).toBeInTheDocument();
  });

  it("saves public paths one per line", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    setMultiline(screen.getByLabelText("Public paths"), "/health\n/status/*");
    await user.click(screen.getByRole("button", { name: "Save public paths" }));

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/security")).toHaveLength(1);
    });
    expect(lastSecurity().publicPaths).toEqual(["/health", "/status/*"]);
  });

  it("keeps the verifiers when saving an unrelated setting", async () => {
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(screen.getByRole("switch", { name: "Require a write key" }));

    await waitFor(() => {
      expect(fake.callsTo("PUT", "/security")).toHaveLength(1);
    });
    // `security` is replaced wholesale, so a partial block would delete the
    // verifiers and take `/v1` down.
    expect(lastSecurity().providers).toHaveLength(1);
  });

  it("shows why a rejected change was rejected", async () => {
    fake.state.rejectSave = "security.providers[0]: jwt requires either secret or jwksUrl";
    const user = userEvent.setup();
    await renderAt("/authentication");

    await user.click(screen.getByRole("switch", { name: "Require a write key" }));

    expect(await screen.findByText(/requires either secret or jwksUrl/)).toBeInTheDocument();
  });
});
