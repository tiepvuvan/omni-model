import { useState } from "react";
import { api, type SimulateResponse } from "../../lib/api";
import { Badge, Button, Callout, Panel, TextAreaField, TextField } from "../ui/primitives";

const OUTCOME_TONE = {
  match: "success",
  "no-match": "neutral",
  "non-boolean": "warning",
  error: "danger",
} as const;

/**
 * Ask the live rules what they would do with a request.
 *
 * This is the antidote to CEL's two silent failures: a missing map key *throws*,
 * and only a literal `true` counts as a match — so a broken rule does not error,
 * it just never fires, and the proxy answers normally from a later rule. Reading
 * the expression will not tell you that. Running it will.
 */
export function SimulatePanel({ suggestedModel }: { suggestedModel: string | null }) {
  const [model, setModel] = useState(suggestedModel ?? "");
  const [userId, setUserId] = useState("");
  const [claimsText, setClaimsText] = useState("{}");
  const [result, setResult] = useState<SimulateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    let claims: Record<string, unknown> | undefined;
    if (claimsText.trim() !== "" && claimsText.trim() !== "{}") {
      try {
        const parsed: unknown = JSON.parse(claimsText);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("claims must be a JSON object");
        }
        claims = parsed as Record<string, unknown>;
      } catch {
        setError('Claims must be a JSON object, for example {"tier": "pro"}.');
        return;
      }
    }

    setBusy(true);
    try {
      setResult(
        await api.simulate({
          model: model.trim(),
          ...(claims === undefined ? {} : { claims }),
          ...(userId.trim() === "" ? {} : { userId: userId.trim() }),
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The simulation failed.");
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Simulate a request"
      description="Evaluate the applied rules against a hypothetical request, rule by rule, without sending anything upstream."
    >
      <form onSubmit={run} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Model"
            mono
            required
            value={model}
            placeholder="gpt-4o-mini"
            onChange={(event) => setModel(event.target.value)}
          />
          <TextField
            label="User id"
            mono
            value={userId}
            hint="Optional; exposed to rules as user.id."
            onChange={(event) => setUserId(event.target.value)}
          />
        </div>

        <TextAreaField
          label="Token claims"
          mono
          rows={3}
          value={claimsText}
          hint="The end user’s token claims, as JSON. Rules read these as user.claims.*"
          onChange={(event) => setClaimsText(event.target.value)}
        />

        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={busy || model.trim() === ""}>
            {busy ? "Simulating…" : "Simulate"}
          </Button>
        </div>
      </form>

      {error !== null ? (
        <div className="mt-4">
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        </div>
      ) : null}

      {result !== null ? (
        <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
          {result.matched ? (
            <Callout tone="success" role="status">
              <span>
                Served by <strong>{result.route}</strong> — {result.provider} as{" "}
                <span className="font-mono">{result.model}</span>
              </span>
            </Callout>
          ) : (
            <Callout tone="warning" role="status">
              {/* Not an error: "nothing serves this" is a real answer, and the
                  proxy would return a 404 for exactly this reason. */}
              <span>No rule matches — this request would be a 404. {result.reason}</span>
            </Callout>
          )}

          {result.warnings.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {result.warnings.map((warning) => (
                <li key={warning}>
                  <Callout tone="danger">{warning}</Callout>
                </li>
              ))}
            </ul>
          ) : null}

          <ol className="flex flex-col gap-1.5">
            {result.rules.map((rule) => (
              <li
                key={rule.rule}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-field)] bg-background-grouped-container px-3 py-2"
              >
                <span className="truncate font-mono text-xs text-foreground-primary">
                  {rule.rule}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {rule.error !== undefined ? (
                    <span className="text-xs text-foreground-secondary">{rule.error}</span>
                  ) : null}
                  <Badge tone={OUTCOME_TONE[rule.outcome]}>{rule.outcome}</Badge>
                </span>
              </li>
            ))}
          </ol>
          {/* `explain` stops at the first match, so a short list is not a bug. */}
          <p className="text-xs text-foreground-secondary">
            Evaluation stops at the first match; rules after it never run.
          </p>
        </div>
      ) : null}
    </Panel>
  );
}
