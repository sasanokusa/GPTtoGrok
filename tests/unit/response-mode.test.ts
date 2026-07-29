import { describe, expect, it } from "vitest";
import {
  buildNextActions,
  computeDiffStats,
  resolveEffectiveResponseMode,
  sha256Hex,
} from "../../src/diff-artifact.js";

const LIMITS = { inlineMaxBytes: 65_536, inlineHardMaxBytes: 1_048_576 };

describe("resolveEffectiveResponseMode", () => {
  it("auto + small diff → full", () => {
    expect(
      resolveEffectiveResponseMode({
        requested: "auto",
        diffBytes: 1024,
        ...LIMITS,
      }),
    ).toEqual({ effective: "full", hardLimitApplied: false });
  });

  it("auto at exactly the threshold stays full (<= is inclusive)", () => {
    expect(
      resolveEffectiveResponseMode({
        requested: "auto",
        diffBytes: 65_536,
        ...LIMITS,
      }).effective,
    ).toBe("full");
  });

  it("auto + large diff → compact", () => {
    expect(
      resolveEffectiveResponseMode({
        requested: "auto",
        diffBytes: 65_537,
        ...LIMITS,
      }),
    ).toEqual({ effective: "compact", hardLimitApplied: false });
  });

  it("auto + empty diff → full", () => {
    expect(
      resolveEffectiveResponseMode({ requested: "auto", diffBytes: 0, ...LIMITS })
        .effective,
    ).toBe("full");
  });

  it("explicit full inlines past the auto threshold", () => {
    expect(
      resolveEffectiveResponseMode({
        requested: "full",
        diffBytes: 500_000,
        ...LIMITS,
      }),
    ).toEqual({ effective: "full", hardLimitApplied: false });
  });

  it("full beyond the hard cap degrades to compact and flags it", () => {
    expect(
      resolveEffectiveResponseMode({
        requested: "full",
        diffBytes: 1_048_577,
        ...LIMITS,
      }),
    ).toEqual({ effective: "compact", hardLimitApplied: true });
  });

  it("auto also respects the hard cap when the threshold is misconfigured high", () => {
    expect(
      resolveEffectiveResponseMode({
        requested: "auto",
        diffBytes: 2_000_000,
        inlineMaxBytes: 8_000_000,
        inlineHardMaxBytes: 1_048_576,
      }),
    ).toEqual({ effective: "compact", hardLimitApplied: true });
  });

  it("threshold 0 means never inline under auto", () => {
    expect(
      resolveEffectiveResponseMode({
        requested: "auto",
        diffBytes: 1,
        inlineMaxBytes: 0,
        inlineHardMaxBytes: 1_048_576,
      }).effective,
    ).toBe("compact");
  });

  it("explicit compact / summary_only are honoured verbatim", () => {
    expect(
      resolveEffectiveResponseMode({
        requested: "compact",
        diffBytes: 10,
        ...LIMITS,
      }),
    ).toEqual({ effective: "compact", hardLimitApplied: false });
    expect(
      resolveEffectiveResponseMode({
        requested: "summary_only",
        diffBytes: 9_000_000,
        ...LIMITS,
      }),
    ).toEqual({ effective: "summary_only", hardLimitApplied: false });
  });
});

describe("computeDiffStats", () => {
  it("returns a consistent zero shape for an empty diff", () => {
    expect(computeDiffStats("")).toEqual({
      files_changed: 0,
      insertions: 0,
      deletions: 0,
    });
  });

  it("counts files, insertions and deletions without counting headers", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "index 111..222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-old line",
      "+new line",
      " context",
      "diff --git a/b.txt b/b.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "",
    ].join("\n");
    expect(computeDiffStats(diff)).toEqual({
      files_changed: 2,
      insertions: 3,
      deletions: 1,
    });
  });

  it("handles a final line without a trailing newline", () => {
    expect(computeDiffStats("diff --git a/x b/x\n+added")).toEqual({
      files_changed: 1,
      insertions: 1,
      deletions: 0,
    });
  });

  it("ignores '\\ No newline at end of file' markers", () => {
    const diff = "diff --git a/x b/x\n+a\n\\ No newline at end of file\n";
    expect(computeDiffStats(diff).insertions).toBe(1);
  });
});

describe("sha256Hex", () => {
  it("matches the well-known empty-string digest", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is byte-exact for multi-byte content", () => {
    const text = "日本語 diff\n";
    expect(sha256Hex(text)).toHaveLength(64);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(text.length);
  });
});

describe("buildNextActions", () => {
  const recoverable = { hasWorktree: true, diffRecoverable: true };

  it("is empty for full (no extra boilerplate per call)", () => {
    expect(buildNextActions("full", recoverable)).toEqual([]);
  });

  it("points compact callers at the artifact", () => {
    const actions = buildNextActions("compact", recoverable);
    expect(actions).toHaveLength(3);
    expect(actions[0]).toContain("worktree_path");
    expect(actions[1]).toContain("diff_artifact_path");
  });

  it("points summary_only callers at a re-run and uses effective_cwd without a worktree", () => {
    const actions = buildNextActions("summary_only", {
      hasWorktree: false,
      diffRecoverable: true,
    });
    expect(actions[0]).toContain("effective_cwd");
    expect(actions[1]).toContain("response_mode");
  });

  it("tells the caller how to recover when nothing survives the call", () => {
    const actions = buildNextActions("summary_only", {
      hasWorktree: true,
      diffRecoverable: false,
    });
    expect(actions).toHaveLength(2);
    expect(actions[0]).toContain("response_mode");
    expect(actions[1]).toContain("keep_worktree");
    // Must not point at a worktree that is about to be removed.
    expect(actions.join(" ")).not.toContain("Inspect changed_files");
  });
});
