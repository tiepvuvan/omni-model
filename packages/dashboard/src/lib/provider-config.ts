import type { ProviderEntry, ProvidersBlock } from "./api";

/** Provider id used by the first-run drafts. */
export const DEFAULT_PROVIDER_ID = "openrouter";

/** A literal environment reference for a credential stored outside the revision. */
export function environmentReference(name: string): string {
  return `\${${name}}`;
}

/** A useful first provider draft; it is not persisted until Save Changes. */
export function starterProviders(): ProvidersBlock {
  return {
    [DEFAULT_PROVIDER_ID]: {
      type: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: environmentReference("OPENROUTER_API_KEY"),
    },
  };
}

/** Factory options without the discriminator owned by the provider card. */
export function providerOptions(entry: ProviderEntry | undefined): Record<string, unknown> {
  if (entry === undefined) return {};
  const { type: _type, ...options } = entry;
  return options;
}
