import { describe, expect, it } from "vitest";
import { GrokMcpError } from "../../src/errors.js";
import { shouldRethrowReviewDiffError } from "../../src/tools/review.js";

describe("shouldRethrowReviewDiffError", () => {
  it("rethrows GROK_MCP_INVALID_ARGS (bad/unsafe/missing base_ref)", () => {
    const err = new GrokMcpError(
      "GROK_MCP_INVALID_ARGS",
      "base_ref must not start with '-' (option injection)",
    );
    expect(shouldRethrowReviewDiffError(err)).toBe(true);
  });

  it("rethrows INVALID_ARGS for nonexistent base_ref", () => {
    const err = new GrokMcpError(
      "GROK_MCP_INVALID_ARGS",
      "base_ref is not a valid commit-ish: nope-does-not-exist",
    );
    expect(shouldRethrowReviewDiffError(err)).toBe(true);
  });

  it("does not rethrow other GrokMcpError codes (degrade path)", () => {
    const err = new GrokMcpError(
      "GROK_MCP_NOT_A_GIT_REPO",
      "Not a git repository",
    );
    expect(shouldRethrowReviewDiffError(err)).toBe(false);
  });

  it("does not rethrow plain Errors (degrade path)", () => {
    expect(shouldRethrowReviewDiffError(new Error("spawn git EACCES"))).toBe(
      false,
    );
  });

  it("does not rethrow non-error values", () => {
    expect(shouldRethrowReviewDiffError("boom")).toBe(false);
    expect(shouldRethrowReviewDiffError(null)).toBe(false);
  });
});
