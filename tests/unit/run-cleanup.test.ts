import { describe, expect, it } from "vitest";
import { planRunCleanup } from "../../src/tools/common.js";

describe("planRunCleanup", () => {
  it("1. success: drops pending, does not remove worktree in finally", () => {
    // Success path already removed the worktree (path null) or left a session record.
    expect(
      planRunCleanup({
        succeeded: true,
        managedWorktreePath: "/cache/worktrees/abc/wt-1",
        keepWorktree: true,
      }),
    ).toEqual({ removeWorktree: false, removePending: true });

    expect(
      planRunCleanup({
        succeeded: true,
        managedWorktreePath: null,
        keepWorktree: false,
      }),
    ).toEqual({ removeWorktree: false, removePending: true });
  });

  it("1b. success + keepWorktree false + path still present: keep pending (removal failed)", () => {
    expect(
      planRunCleanup({
        succeeded: true,
        managedWorktreePath: "/cache/worktrees/abc/wt-1",
        keepWorktree: false,
      }),
    ).toEqual({ removeWorktree: false, removePending: false });
  });

  it("2. failure + keepWorktree false + managed worktree: remove both (pending only if remove succeeds)", () => {
    // Call site must KEEP pending if removeWorktree returns false or throws.
    expect(
      planRunCleanup({
        succeeded: false,
        managedWorktreePath: "/cache/worktrees/abc/wt-1",
        keepWorktree: false,
      }),
    ).toEqual({ removeWorktree: true, removePending: true });
  });

  it("3. failure + keep worktree (true/undefined): keep pending so GC can reap", () => {
    expect(
      planRunCleanup({
        succeeded: false,
        managedWorktreePath: "/cache/worktrees/abc/wt-1",
        keepWorktree: true,
      }),
    ).toEqual({ removeWorktree: false, removePending: false });

    expect(
      planRunCleanup({
        succeeded: false,
        managedWorktreePath: "/cache/worktrees/abc/wt-1",
        keepWorktree: undefined,
      }),
    ).toEqual({ removeWorktree: false, removePending: false });
  });

  it("4. no managed worktree created: drop pending (harmless no-op if never added)", () => {
    expect(
      planRunCleanup({
        succeeded: false,
        managedWorktreePath: null,
        keepWorktree: true,
      }),
    ).toEqual({ removeWorktree: false, removePending: true });

    expect(
      planRunCleanup({
        succeeded: false,
        managedWorktreePath: null,
        keepWorktree: false,
      }),
    ).toEqual({ removeWorktree: false, removePending: true });

    // read_only / early failure before createManagedWorktree
    expect(
      planRunCleanup({
        succeeded: true,
        managedWorktreePath: null,
        keepWorktree: undefined,
      }),
    ).toEqual({ removeWorktree: false, removePending: true });
  });
});
