import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedWorktree, removeWorktree } from "../../src/worktree.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function initRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-repo-"));
  tmpDirs.push(d);
  execFileSync("git", ["init"], { cwd: d });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: d });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: d });
  fs.writeFileSync(path.join(d, "f.txt"), "x\n");
  execFileSync("git", ["add", "f.txt"], { cwd: d });
  execFileSync("git", ["commit", "-m", "init"], { cwd: d });
  return d;
}

describe("worktree manager", () => {
  it("creates managed worktree outside repo root", async () => {
    const repo = initRepo();
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-root-"));
    tmpDirs.push(wtRoot);
    const created = await createManagedWorktree({
      repoRoot: repo,
      worktreesRoot: wtRoot,
      tool: "grok_implement",
      name: "test-wt-1",
    });
    expect(fs.existsSync(created.worktreePath)).toBe(true);
    const realRoot = fs.realpathSync(wtRoot);
    const realRepo = fs.realpathSync(repo);
    expect(created.worktreePath.startsWith(realRoot + path.sep)).toBe(true);
    // Worktree must not be nested inside the source repo path
    expect(created.worktreePath.startsWith(realRepo + path.sep)).toBe(false);
    expect(created.worktreeName).toBe("test-wt-1");

    await removeWorktree(repo, created.worktreePath);
  });

  it("errors on name collision", async () => {
    const repo = initRepo();
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-root-"));
    tmpDirs.push(wtRoot);
    await createManagedWorktree({
      repoRoot: repo,
      worktreesRoot: wtRoot,
      tool: "grok_implement",
      name: "dup",
    });
    await expect(
      createManagedWorktree({
        repoRoot: repo,
        worktreesRoot: wtRoot,
        tool: "grok_implement",
        name: "dup",
      }),
    ).rejects.toMatchObject({ code: "GROK_MCP_WORKTREE_EXISTS" });
  });
});
