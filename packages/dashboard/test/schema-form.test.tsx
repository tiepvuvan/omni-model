import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mergeCredentials, SchemaForm } from "../src/components/schema-form";
import type { JsonSchema } from "../src/lib/api";

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    apiKey: { type: "string" },
    baseUrl: { type: "string" },
    maxTokensDefault: { type: "integer", minimum: 1 },
    includeStreamUsage: { type: "boolean" },
    models: { type: "array", items: { type: "string" } },
    headers: { type: "object" },
    scheme: { type: "string", enum: ["bearer", "raw"] },
  },
  required: ["baseUrl"],
};

describe("generated labels", () => {
  it("labels a camelCase property the way the design writes it", () => {
    render(
      <SchemaForm
        schema={SCHEMA}
        values={{}}
        onChange={() => undefined}
        idPrefix="t"
        omit={["type"]}
      />,
    );

    // Title Case with acronyms uppercased, exactly as the Figma file labels
    // them. "Api key" / "Base url" is the drift this asserts against.
    expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Max Tokens Default")).toBeInTheDocument();
  });

  it("picks a control per schema type", () => {
    render(
      <SchemaForm
        schema={SCHEMA}
        values={{}}
        onChange={() => undefined}
        idPrefix="t"
        omit={["type"]}
      />,
    );

    expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Max Tokens Default")).toHaveAttribute("type", "number");
    // A list is a chip box: an <input> that commits one value at a time.
    expect(screen.getByLabelText("Models").tagName).toBe("INPUT");
    expect(screen.getByLabelText("Headers").tagName).toBe("TEXTAREA");
    expect(screen.getByRole("switch", { name: "Include Stream Usage" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /scheme/i })).toBeInTheDocument();
  });

  it("omits what the surrounding UI owns", () => {
    render(
      <SchemaForm
        schema={SCHEMA}
        values={{}}
        onChange={() => undefined}
        idPrefix="t"
        omit={["type", "apiKey"]}
      />,
    );

    expect(screen.queryByLabelText("API Key")).toBeNull();
  });

  it("says so when a component publishes no schema", () => {
    render(<SchemaForm schema={null} values={{}} onChange={() => undefined} idPrefix="t" />);

    expect(screen.getByText(/publishes no options schema/)).toBeInTheDocument();
  });
});

describe("mergeCredentials", () => {
  it("restores a sealed reference the operator did not touch", () => {
    const merged = mergeCredentials({ baseUrl: "https://x.test" }, { apiKey: { $secret: "s1" } });

    expect(merged.apiKey).toEqual({ $secret: "s1" });
  });

  it("restores an environment reference the operator did not touch", () => {
    const merged = mergeCredentials({}, { apiKey: "${OPENAI_API_KEY}" });

    expect(merged.apiKey).toBe("${OPENAI_API_KEY}");
  });

  it("keeps a newly typed value", () => {
    const merged = mergeCredentials({ apiKey: "sk-new" }, { apiKey: { $secret: "s1" } });

    expect(merged.apiKey).toBe("sk-new");
  });

  it("leaves a credential absent when nothing was stored", () => {
    // Sending `""` would fail the factory's own validation, so an untouched field
    // with nothing behind it must stay missing rather than become empty.
    const merged = mergeCredentials({ apiKey: "" }, {});

    expect("apiKey" in merged).toBe(false);
  });
});
