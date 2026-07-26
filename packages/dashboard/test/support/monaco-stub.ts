import { diagnose } from "../../src/components/routing/cel";

/**
 * A stand-in for `cel-monaco.ts` in jsdom.
 *
 * Monaco measures glyphs, owns a canvas-backed view and asks for layout that jsdom
 * does not have — it cannot construct there, and a screen embedding it renders
 * nothing at all. Driving a real Monaco needs a real browser, which is what the
 * browser pass is for.
 *
 * What this deliberately does *not* stub is the part worth testing: the CEL
 * language itself — tokens, completions, diagnostics — lives in `cel.ts` and is
 * covered directly by `cel.test.ts` and `facts-parity.test.ts` against core's
 * `RequestFacts`. So the only thing replaced here is the widget, and everything
 * `CelEditor` does around it (value sync, marker updates, the status line) still
 * runs for real against a textarea.
 */
export const CEL_LANGUAGE = "omni-cel";
export const CEL_THEME_LIGHT = "omni-cel-light";
export const CEL_THEME_DARK = "omni-cel-dark";

export function registerCel(): void {
  // Nothing to register: there is no Monaco language registry here.
}

/** Markers the component asked for, so a test can assert they were pushed. */
export const markers: { text: string; messages: string[] }[] = [];

export function setMarkers(model: { getValue(): string }, serverError: string | null): void {
  const text = model.getValue();
  markers.push({
    text,
    messages:
      serverError != null && serverError !== ""
        ? [serverError]
        : diagnose(text).map((entry) => entry.message),
  });
}

type Listener = () => void;

/**
 * The slice of Monaco's API `CelEditor` uses, over a real textarea.
 *
 * A textarea rather than a div so the editor is still a labelled form control that
 * a test can type into by name — the screen's own behaviour is then exercised the
 * same way an operator exercises it.
 */
export const monaco = {
  editor: {
    create(host: HTMLElement, options: { value: string; ariaLabel?: string }) {
      const field = document.createElement("textarea");
      field.value = options.value;
      if (options.ariaLabel !== undefined) field.setAttribute("aria-label", options.ariaLabel);
      host.appendChild(field);

      const listeners: Listener[] = [];
      field.addEventListener("input", () => {
        for (const listener of listeners) listener();
      });

      const model = {
        getValue: () => field.value,
        dispose: () => {},
      };

      return {
        getValue: () => field.value,
        setValue: (next: string) => {
          field.value = next;
        },
        getModel: () => model,
        onDidChangeModelContent: (listener: Listener) => {
          listeners.push(listener);
          return {
            dispose: () => {
              const at = listeners.indexOf(listener);
              if (at !== -1) listeners.splice(at, 1);
            },
          };
        },
        dispose: () => {
          field.remove();
        },
      };
    },
    setTheme: () => {},
  },
};
