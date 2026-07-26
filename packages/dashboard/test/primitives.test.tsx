import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TextAreaField, TextField } from "../src/components/ui/primitives";

/**
 * The accessible name of a labelled control.
 *
 * Both defects below were invisible until something asked for a field *by* its
 * label: a hint folded into the name reads as part of the field's title, and a
 * generated label in the wrong case silently stops matching a hand-written one.
 */
describe("field labelling", () => {
  it("keeps a text field's hint out of its accessible name", () => {
    render(<TextField label="Condition" hint="A CEL expression over request and user." />);

    expect(screen.getByLabelText("Condition")).toBeInTheDocument();
  });

  it("keeps a textarea's hint out of its accessible name", () => {
    // The original wrapped the control *and* the hint in one `<label>`, so a
    // screen reader announced the whole explanation as the field's name.
    render(<TextAreaField label="Allowed models" hint="One per line." />);

    const field = screen.getByLabelText("Allowed models");
    expect(field.tagName).toBe("TEXTAREA");
    expect(field).toHaveAccessibleDescription("One per line.");
  });

  it("associates a textarea with its own label, not a neighbour's", () => {
    render(
      <>
        <TextAreaField label="First" />
        <TextAreaField label="Second" />
      </>,
    );

    const first = screen.getByLabelText("First");
    const second = screen.getByLabelText("Second");
    expect(first).not.toBe(second);
  });
});
