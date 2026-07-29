import { describe, expect, it } from "vitest";
import {
  digestDiffAssembly,
  evaluateReadOnlyMutation,
} from "../../src/tools/common.js";

describe("digestDiffAssembly / evaluateReadOnlyMutation", () => {
  it("same digest → no warning and suppress pre-existing WIP", () => {
    const dig = digestDiffAssembly({
      changedFiles: ["tracked.ts", "untracked.txt"],
      diff: "diff --git a/tracked.ts b/tracked.ts\n+old\n",
    });
    const decision = evaluateReadOnlyMutation(dig, dig);
    expect(decision.unexpectedMutation).toBe(false);
    expect(decision.useEmptyDiff).toBe(true);
  });

  it("clean tree digest stays clean", () => {
    const dig = digestDiffAssembly({ changedFiles: [], diff: "" });
    const decision = evaluateReadOnlyMutation(dig, dig);
    expect(decision.unexpectedMutation).toBe(false);
    expect(decision.useEmptyDiff).toBe(true);
  });

  it("different digests → UNEXPECTED_MUTATION and keep post-run diff", () => {
    const before = digestDiffAssembly({
      changedFiles: ["tracked.ts"],
      diff: "diff --git a/tracked.ts b/tracked.ts\n+v1\n",
    });
    const after = digestDiffAssembly({
      changedFiles: ["tracked.ts", "new.txt"],
      diff: "diff --git a/tracked.ts b/tracked.ts\n+v1\n",
    });
    const decision = evaluateReadOnlyMutation(before, after);
    expect(decision.unexpectedMutation).toBe(true);
    expect(decision.useEmptyDiff).toBe(false);
  });

  it("detects content edits when porcelain path list is identical", () => {
    // Same changed_files (porcelain-equivalent), different patch body — the
    // porcelain-only check would have missed this; digests must not.
    const files = ["already-dirty.ts"];
    const before = digestDiffAssembly({
      changedFiles: files,
      diff: "diff --git a/already-dirty.ts b/already-dirty.ts\n@@ -1 +1,2 @@\n foo\n+caller wip\n",
    });
    const after = digestDiffAssembly({
      changedFiles: files,
      diff: "diff --git a/already-dirty.ts b/already-dirty.ts\n@@ -1 +1,3 @@\n foo\n+caller wip\n+grok edit\n",
    });
    expect(before).not.toBe(after);
    const decision = evaluateReadOnlyMutation(before, after);
    expect(decision.unexpectedMutation).toBe(true);
    expect(decision.useEmptyDiff).toBe(false);
  });

  it("detects content edits to an already-untracked file (same path list)", () => {
    const files = ["scratch.txt"];
    const before = digestDiffAssembly({
      changedFiles: files,
      diff: "diff --git a/scratch.txt b/scratch.txt\nnew file mode 100644\n--- /dev/null\n+++ b/scratch.txt\n@@ -0,0 +1 @@\n+line1\n",
    });
    const after = digestDiffAssembly({
      changedFiles: files,
      diff: "diff --git a/scratch.txt b/scratch.txt\nnew file mode 100644\n--- /dev/null\n+++ b/scratch.txt\n@@ -0,0 +1,2 @@\n+line1\n+line2 from grok\n",
    });
    expect(before).not.toBe(after);
    expect(evaluateReadOnlyMutation(before, after)).toEqual({
      unexpectedMutation: true,
      useEmptyDiff: false,
    });
  });

  it("null baseline → skip silently (not a git repo / capture failed)", () => {
    const decision = evaluateReadOnlyMutation(null, null);
    expect(decision.unexpectedMutation).toBe(false);
    expect(decision.useEmptyDiff).toBe(false);
  });

  it("null after digest → skip silently", () => {
    const before = digestDiffAssembly({
      changedFiles: ["a.ts"],
      diff: "+x\n",
    });
    const decision = evaluateReadOnlyMutation(before, null);
    expect(decision.unexpectedMutation).toBe(false);
    expect(decision.useEmptyDiff).toBe(false);
  });
});
