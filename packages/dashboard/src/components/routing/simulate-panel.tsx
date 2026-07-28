import { useState } from "react";
import { api, type SimulateResponse } from "../../lib/api";
import { Badge, Button, Callout, Modal, TextAreaField, TextField } from "../ui/primitives";

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
export function SimulatePanel({
  open,
  onOpenChange,
  suggestedModel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suggestedModel: string | null;
}) {
  const [model, setModel] = useState(suggestedModel ?? "");
  const [inputTokenCount, setInputTokenCount] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [temperature, setTemperature] = useState("");
  const [userId, setUserId] = useState("");
  const [providersText, setProvidersText] = useState("");
  const [claimsText, setClaimsText] = useState("{}");
  const [clientName, setClientName] = useState("");
  const [ip, setIp] = useState("");
  const [method, setMethod] = useState("POST");
  const [path, setPath] = useState("/v1/chat/completions");
  const [headersText, setHeadersText] = useState("{}");
  const [result, setResult] = useState<SimulateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const parseMap = (value: string, label: string): Record<string, unknown> | undefined => {
      if (value.trim() === "" || value.trim() === "{}") return undefined;
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error(`${label} must be a JSON object`);
        }
        return parsed as Record<string, unknown>;
      } catch {
        setError(`${label} must be a JSON object.`);
        return undefined;
      }
    };

    const claims = parseMap(claimsText, "Claims");
    if (claimsText.trim() !== "" && claimsText.trim() !== "{}" && claims === undefined) {
      return;
    }
    const rawHeaders = parseMap(headersText, "Headers");
    if (headersText.trim() !== "" && headersText.trim() !== "{}" && rawHeaders === undefined) {
      return;
    }
    const headers =
      rawHeaders === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(rawHeaders).map(([key, value]) => [key, String(value)]),
          );

    const optionalNumber = (value: string): number | undefined => {
      const trimmed = value.trim();
      return trimmed === "" ? undefined : Number(trimmed);
    };
    const simulatedInputTokenCount = optionalNumber(inputTokenCount);
    const simulatedMaxTokens = optionalNumber(maxTokens);
    const simulatedTemperature = optionalNumber(temperature);
    const providers = providersText
      .split(",")
      .map((provider) => provider.trim())
      .filter((provider) => provider !== "");

    for (const [label, value] of [
      ["Input token count", simulatedInputTokenCount],
      ["Maximum tokens", simulatedMaxTokens],
      ["Temperature", simulatedTemperature],
    ] as const) {
      if (value !== undefined && !Number.isFinite(value)) {
        setError(`${label} must be a number.`);
        return;
      }
    }

    setBusy(true);
    try {
      setResult(
        await api.simulate({
          model: model.trim(),
          ...(simulatedInputTokenCount === undefined
            ? {}
            : { inputTokenCount: simulatedInputTokenCount }),
          ...(simulatedMaxTokens === undefined ? {} : { maxTokens: simulatedMaxTokens }),
          ...(simulatedTemperature === undefined ? {} : { temperature: simulatedTemperature }),
          ...(claims === undefined ? {} : { claims }),
          ...(userId.trim() === "" ? {} : { userId: userId.trim() }),
          ...(providers.length === 0 ? {} : { providers }),
          ...(clientName.trim() === "" ? {} : { clientName: clientName.trim() }),
          ...(ip.trim() === "" ? {} : { ip: ip.trim() }),
          ...(method.trim() === "" ? {} : { method: method.trim().toUpperCase() }),
          ...(path.trim() === "" ? {} : { path: path.trim() }),
          ...(headers === undefined ? {} : { headers }),
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
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Simulate a request"
      description="Evaluate a hypothetical request against the currently applied routing rules."
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
            label="Input token count"
            mono
            type="number"
            min={0}
            value={inputTokenCount}
            placeholder="Estimated from the simulated body"
            onChange={(event) => setInputTokenCount(event.target.value)}
          />
          <TextField
            label="Maximum output tokens"
            mono
            type="number"
            min={0}
            value={maxTokens}
            onChange={(event) => setMaxTokens(event.target.value)}
          />
          <TextField
            label="Temperature"
            mono
            type="number"
            step="any"
            value={temperature}
            onChange={(event) => setTemperature(event.target.value)}
          />
          <TextField
            label="User id"
            mono
            value={userId}
            help="Optional; exposed to rules as user.id."
            onChange={(event) => setUserId(event.target.value)}
          />
          <TextField
            label="User providers"
            mono
            value={providersText}
            placeholder="firebase-auth, firebase-app-check"
            help="Comma-separated verifier types exposed as user.providers."
            onChange={(event) => setProvidersText(event.target.value)}
          />
          <TextField
            label="Client name"
            mono
            value={clientName}
            placeholder="ios-app"
            onChange={(event) => setClientName(event.target.value)}
          />
          <TextField
            label="IP address"
            mono
            value={ip}
            placeholder="203.0.113.10"
            onChange={(event) => setIp(event.target.value)}
          />
          <TextField
            label="HTTP method"
            mono
            value={method}
            onChange={(event) => setMethod(event.target.value)}
          />
          <TextField
            label="HTTP path"
            mono
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
        </div>

        <TextAreaField
          label="Token claims"
          mono
          rows={3}
          value={claimsText}
          help="The end user’s token claims, as JSON. Rules read these as user.claims.*"
          onChange={(event) => setClaimsText(event.target.value)}
        />

        <TextAreaField
          label="HTTP headers"
          mono
          rows={3}
          value={headersText}
          help='A JSON object. Credential-bearing values are exposed as "<redacted>".'
          onChange={(event) => setHeadersText(event.target.value)}
        />

        <div className="-mx-[16px] flex justify-end gap-[8px] border-t border-solid border-border px-[16px] pt-[12px]">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || model.trim() === ""}>
            {busy ? "Simulating…" : "Simulate"}
          </Button>
        </div>
      </form>

      {error !== null ? (
        <div className="mt-[16px] w-full">
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        </div>
      ) : null}

      {result !== null ? (
        <div className="mt-[16px] flex w-full flex-col gap-[12px] border-t border-solid border-border pt-[16px]">
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
                className="flex items-center justify-between gap-3 rounded-[var(--radius-field)] bg-background-grouped-container px-[12px] py-[8px]"
              >
                <span className="truncate type-mono-12 text-foreground-primary">{rule.rule}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {rule.error !== undefined ? (
                    <span className="type-label-12 text-foreground-secondary">{rule.error}</span>
                  ) : null}
                  <Badge tone={OUTCOME_TONE[rule.outcome]}>{rule.outcome}</Badge>
                </span>
              </li>
            ))}
          </ol>
          {/* `explain` stops at the first match, so a short list is not a bug. */}
          <p className="type-label-12 text-foreground-secondary">
            Evaluation stops at the first match; rules after it never run.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
