/**
 * Estimate the number of model-input tokens in a JSON request body.
 *
 * Tokenization differs between upstreams and models, so the proxy deliberately
 * uses one stable provider-neutral estimate: four ASCII characters per token,
 * while each non-ASCII Unicode code point counts as one token. The latter keeps
 * CJK and emoji-heavy input from being materially undercounted.
 */
export function estimateInputTokens(value: unknown): number {
  const text = JSON.stringify(value);
  if (text === undefined || text.length === 0) return 0;

  let asciiCharacters = 0;
  let nonAsciiCodePoints = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) asciiCharacters += 1;
    else nonAsciiCodePoints += 1;
  }
  return Math.ceil(asciiCharacters / 4) + nonAsciiCodePoints;
}

/**
 * Maximum raw bytes worth buffering before a request cannot plausibly fit its
 * input-token limit. UTF-8 uses at most four bytes per Unicode code point, which
 * is also the estimator's least restrictive ratio.
 */
export function inputTokenBodyByteCeiling(maxInputTokens: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, maxInputTokens * 4);
}
