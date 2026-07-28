import { useState } from "react";
import { Button, cx } from "../ui/primitives";
import { FUNCTIONS, NAMESPACES } from "./cel";

/**
 * What a condition can refer to, listed under the editor.
 *
 * Autocomplete only helps someone who already knows a namespace exists — you have
 * to type `user.` to find out what `user` has. This is the other half: the whole
 * surface visible at a glance, with a worked example per field, so the first
 * question ("what can I even match on?") is answerable without guessing.
 *
 * Generated from the same `NAMESPACES` and `FUNCTIONS` the editor completes from,
 * which are checked against core's `RequestFacts` by `facts-parity.test.ts`. So
 * this cannot document a field the router does not expose.
 */

/** A usable expression for one field, not just its name. */
function exampleFor(namespace: string, field: string, type: string, dynamic?: boolean): string {
  const path = `${namespace}.${field}`;
  if (dynamic === true) {
    // The guard is the example. An unguarded read throws, and the router turns a
    // throw into "no match" — so a rule written the obvious way never fires.
    const key = namespace === "user" ? "tier" : "x_tenant";
    return `has(${path}.${key}) && ${path}.${key} == "value"`;
  }
  if (type.startsWith("boolean")) return `${path} == true`;
  if (type.startsWith("number")) return `${path} > 4`;
  if (type.startsWith("list")) return `"firebase-auth" in ${path}`;
  if (field === "model") return `${path}.startsWith("claude-")`;
  return `${path} == "value"`;
}

export function CelReference() {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex w-full flex-col gap-[8px]">
      <div className="flex items-center justify-between gap-[8px]">
        <p className="type-label-12 text-foreground-secondary">
          A CEL expression over {NAMESPACES.map((entry) => entry.name).join(", ")}. Only a literal{" "}
          <span className="type-mono-12">true</span> counts as a match. Ctrl-Space for suggestions.
        </p>
        <Button size="medium" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide variables" : "Show variables"}
        </Button>
      </div>

      {open ? (
        <div className="flex w-full flex-col gap-[12px] rounded-[var(--radius-field)] border border-solid border-border bg-background-grouped-content p-[12px]">
          {NAMESPACES.map((namespace) => (
            <div key={namespace.name} className="flex flex-col gap-[6px]">
              <p className="type-strong-13 text-foreground-primary">
                <span className="type-mono-12">{namespace.name}</span> — {namespace.detail}
              </p>
              <table className="w-full border-collapse">
                <tbody>
                  {namespace.fields.map((field) => (
                    <tr key={field.name} className="align-top">
                      <td className="w-[26%] py-[2px] pr-[8px] type-mono-12 text-foreground-primary">
                        {namespace.name}.{field.name}
                      </td>
                      <td className="w-[16%] py-[2px] pr-[8px] type-label-12 text-foreground-secondary">
                        {field.type}
                      </td>
                      <td className="py-[2px] type-mono-12 text-accent-subtle-foreground">
                        {exampleFor(namespace.name, field.name, field.type, field.dynamic)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <div className="flex flex-col gap-[6px] border-t border-solid border-border pt-[12px]">
            <p className="type-strong-13 text-foreground-primary">Functions</p>
            <ul className="flex flex-col gap-[2px]">
              {FUNCTIONS.map((fn) => (
                <li key={fn.name} className="type-mono-12 text-foreground-secondary">
                  {fn.detail}
                </li>
              ))}
            </ul>
          </div>

          <p
            className={cx(
              "rounded-[var(--radius-field)] border border-solid border-yellow-subtle-foreground/30",
              "bg-yellow-subtle px-[10px] py-[8px] type-label-12 text-yellow-subtle-foreground",
            )}
          >
            Reading a claim or header that is absent <strong>throws</strong>, and the router treats
            a throw as no match — so the rule silently never fires and a later one answers instead.
            Always guard with <span className="type-mono-12">has()</span>.
          </p>
        </div>
      ) : null}
    </div>
  );
}
