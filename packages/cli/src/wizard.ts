import { cancel, isCancel, multiselect, note, select, text } from "@clack/prompts";
import { type Answers, type AuthId, envRef, type ProviderChoice } from "./config.js";
import { type StorageId, storagesFor, TARGETS, type TargetId } from "./targets.js";

/** Abort cleanly on Ctrl-C rather than throwing a stack trace at the user. */
function stopIfCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Cancelled — nothing was deployed.");
    process.exit(0);
  }
  return value as T;
}

const PROVIDER_OPTIONS: { value: ProviderChoice; label: string; hint: string }[] = [
  {
    value: { id: "openai", name: "openai", envVar: "OPENAI_API_KEY" },
    label: "OpenAI",
    hint: "gpt-4o, gpt-4o-mini …",
  },
  {
    value: { id: "anthropic", name: "anthropic", envVar: "ANTHROPIC_API_KEY" },
    label: "Anthropic",
    hint: "claude-* (translated to the OpenAI wire format)",
  },
  {
    value: { id: "google", name: "google", envVar: "GEMINI_API_KEY" },
    label: "Google Gemini",
    hint: "gemini-* (translated)",
  },
  {
    value: {
      id: "openai-compatible",
      name: "openrouter",
      envVar: "OPENROUTER_API_KEY",
      baseUrl: "https://openrouter.ai/api/v1",
    },
    label: "OpenAI-compatible",
    hint: "OpenRouter, Groq, Together, vLLM …",
  },
];

const AUTH_OPTIONS: { value: AuthId; label: string; hint: string }[] = [
  { value: "firebase-auth", label: "Firebase Auth", hint: "your users' ID tokens" },
  { value: "firebase-app-check", label: "Firebase App Check", hint: "attests the app instance" },
  { value: "apple-app-attest", label: "Apple App Attest", hint: "iOS, hardware-backed" },
  { value: "apple-device-check", label: "Apple DeviceCheck", hint: "iOS, per-device" },
];

/** Run the interactive wizard and return everything needed to build a config. */
export async function runWizard(): Promise<Answers> {
  const target = stopIfCancelled(
    await select<TargetId>({
      message: "Where do you want to deploy?",
      options: Object.values(TARGETS).map((t) => ({
        value: t.id,
        label: t.label,
        hint: t.hint,
      })),
    }),
  );

  const storageOptions = storagesFor(target);
  const storage = stopIfCancelled(
    await select<StorageId>({
      message: "Where should rate-limit counters live?",
      // The first entry is the recommended default for this target.
      initialValue: storageOptions[0]?.id,
      options: storageOptions.map((s) => ({ value: s.id, label: s.label, hint: s.hint })),
    }),
  );

  if (storage === "memory") {
    note(
      "In-memory counters aren't shared between instances, so limits apply per\ninstance. Fine for a try-out; pick a shared store before production.",
      "Heads up",
    );
  }

  const provider = stopIfCancelled(
    await select<ProviderChoice>({
      message: "Which upstream provider?",
      options: PROVIDER_OPTIONS,
    }),
  );

  // openai-compatible covers many vendors, so let the user name it + point it.
  const chosen: ProviderChoice = { ...provider };
  if (chosen.id === "openai-compatible") {
    chosen.baseUrl = stopIfCancelled(
      await text({
        message: "Base URL of the OpenAI-compatible API",
        initialValue: chosen.baseUrl,
        validate: (v) => (v?.startsWith("http") ? undefined : "Must be an http(s) URL"),
      }),
    );
    chosen.name = stopIfCancelled(
      await text({
        message: "Name for this provider (used in routing)",
        initialValue: chosen.name,
        validate: (v) =>
          v && /^[a-z0-9-]+$/.test(v) ? undefined : "Lowercase letters, digits and -",
      }),
    );
    chosen.envVar = stopIfCancelled(
      await text({
        message: "Environment variable holding its API key",
        initialValue: chosen.envVar,
        validate: (v) => (v && /^[A-Z_][A-Z0-9_]*$/.test(v) ? undefined : "UPPER_SNAKE_CASE"),
      }),
    );
  }

  // At least one is mandatory: the proxy refuses to start without a verifier,
  // because one that authenticates nobody is an open relay on your credits.
  const auth = stopIfCancelled(
    await multiselect<AuthId>({
      message: "How should clients authenticate? (space to select, enter to confirm)",
      options: AUTH_OPTIONS,
      required: true,
    }),
  );

  const answers: Answers = { target, storage, provider: chosen, auth };

  if (auth.includes("firebase-auth")) {
    answers.firebaseProjectId = stopIfCancelled(
      await text({
        message: "Firebase project id (from GoogleService-Info.plist PROJECT_ID)",
        placeholder: `leave blank to read ${envRef("FIREBASE_PROJECT_ID")} at runtime`,
        defaultValue: "",
      }),
    );
  }
  if (auth.includes("firebase-app-check")) {
    answers.firebaseProjectNumber = stopIfCancelled(
      await text({
        message: "Firebase project number (GCM_SENDER_ID)",
        placeholder: `leave blank to read ${envRef("FIREBASE_PROJECT_NUMBER")} at runtime`,
        defaultValue: "",
      }),
    );
  }
  if (auth.includes("apple-app-attest") || auth.includes("apple-device-check")) {
    answers.appleTeamId = stopIfCancelled(
      await text({
        message: "Apple Team ID",
        placeholder: `leave blank to read ${envRef("APPLE_TEAM_ID")} at runtime`,
        defaultValue: "",
      }),
    );
  }
  if (auth.includes("apple-app-attest")) {
    answers.appleBundleId = stopIfCancelled(
      await text({
        message: "App bundle id",
        placeholder: `leave blank to read ${envRef("APPLE_BUNDLE_ID")} at runtime`,
        defaultValue: "",
      }),
    );
  }

  answers.requestsPerHour = Number(
    stopIfCancelled(
      await text({
        message: "Requests per hour, per caller (0 for no limit)",
        initialValue: "30",
        validate: (v) => (v && /^\d+$/.test(v) ? undefined : "A whole number"),
      }),
    ),
  );
  answers.tokensPerDay = Number(
    stopIfCancelled(
      await text({
        message: "Token budget per caller per day (0 for no budget)",
        initialValue: "30000",
        validate: (v) => (v && /^\d+$/.test(v) ? undefined : "A whole number"),
      }),
    ),
  );

  // Blank answers mean "read it from the environment"; drop them so the config
  // emits a ${VAR} reference instead of an empty literal.
  if (answers.firebaseProjectId === "") answers.firebaseProjectId = undefined;
  if (answers.firebaseProjectNumber === "") answers.firebaseProjectNumber = undefined;
  if (answers.appleTeamId === "") answers.appleTeamId = undefined;
  if (answers.appleBundleId === "") answers.appleBundleId = undefined;

  return answers;
}
