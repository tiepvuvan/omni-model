import { describe, expect, it } from "vitest";
import { estimateInputTokens, inputTokenBodyByteCeiling } from "../../src/util/input-tokens.js";

describe("input token estimation", () => {
  it("uses four ASCII characters per token over normalized JSON", () => {
    expect(estimateInputTokens("abcd")).toBe(2);
    expect(estimateInputTokens({ value: "abcdefgh" })).toBe(5);
  });

  it("counts non-ASCII code points individually", () => {
    expect(estimateInputTokens("你好")).toBe(3);
    expect(estimateInputTokens("🙂")).toBe(2);
  });

  it("derives a bounded UTF-8 read ceiling from the token limit", () => {
    expect(inputTokenBodyByteCeiling(128_000)).toBe(512_000);
    expect(inputTokenBodyByteCeiling(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
