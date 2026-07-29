import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertServerManagedWorktree,
  createManagedWorktree,
  removeWorktree,
} from "../../src/worktree.js";

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
    expect(created.managed).toBe(true);

    await removeWorktree(repo, created.worktreePath, wtRoot);
    expect(fs.existsSync(created.worktreePath)).toBe(false);
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

  it("assertServerManagedWorktree accepts createManagedWorktree result", async () => {
    const repo = initRepo();
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-root-"));
    tmpDirs.push(wtRoot);
    const created = await createManagedWorktree({
      repoRoot: repo,
      worktreesRoot: wtRoot,
      tool: "grok_implement",
      name: "assert-ok",
    });
    const real = await assertServerManagedWorktree({
      worktreePath: created.worktreePath,
      repoRoot: repo,
      worktreesRoot: wtRoot,
    });
    expect(real).toBe(fs.realpathSync(created.worktreePath));
    await removeWorktree(repo, created.worktreePath, wtRoot);
  });

  it("assertServerManagedWorktree rejects relative path", async () => {
    const repo = initRepo();
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-root-"));
    tmpDirs.push(wtRoot);
    await expect(
      assertServerManagedWorktree({
        worktreePath: "relative/worktree",
        repoRoot: repo,
        worktreesRoot: wtRoot,
      }),
    ).rejects.toMatchObject({ code: "GROK_MCP_INVALID_ARGS" });
  });

  it("assertServerManagedWorktree rejects original repo root", async () => {
    const repo = initRepo();
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-root-"));
    tmpDirs.push(wtRoot);
    await expect(
      assertServerManagedWorktree({
        worktreePath: repo,
        repoRoot: repo,
        worktreesRoot: wtRoot,
      }),
    ).rejects.toMatchObject({ code: "GROK_MCP_WORKTREE_INVALID" });
  });

  it("assertServerManagedWorktree rejects path outside worktrees root", async () => {
    const repo = initRepo();
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-out-"));
    tmpDirs.push(wtRoot, outside);
    await expect(
      assertServerManagedWorktree({
        worktreePath: outside,
        repoRoot: repo,
        worktreesRoot: wtRoot,
      }),
    ).rejects.toMatchObject({ code: "GROK_MCP_WORKTREE_INVALID" });
  });

  it("assertServerManagedWorktree rejects unregistered directory under root", async () => {
    const repo = initRepo();
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-root-"));
    tmpDirs.push(wtRoot);
    const fake = path.join(wtRoot, "not-registered");
    fs.mkdirSync(fake, { recursive: true });
    await expect(
      assertServerManagedWorktree({
        worktreePath: fake,
        repoRoot: repo,
        worktreesRoot: wtRoot,
      }),
    ).rejects.toMatchObject({ code: "GROK_MCP_WORKTREE_INVALID" });
  });

  it("assertServerManagedWorktree rejects worktree registered to a different repo", async () => {
    const repoA = initRepo();
    const repoB = initRepo();
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-root-"));
    tmpDirs.push(wtRoot);
    const created = await createManagedWorktree({
      repoRoot: repoA,
      worktreesRoot: wtRoot,
      tool: "grok_implement",
      name: "other-repo-wt",
    });
    await expect(
      assertServerManagedWorktree({
        worktreePath: created.worktreePath,
        repoRoot: repoB,
        worktreesRoot: wtRoot,
      }),
    ).rejects.toMatchObject({ code: "GROK_MCP_WORKTREE_INVALID" });
    await removeWorktree(repoA, created.worktreePath, wtRoot);
  });

  it("removeWorktree leaves an outside sentinel directory untouched and returns false", async () => {
    const repo = initRepo();
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-sentinel-"));
    tmpDirs.push(wtRoot, outside);
    const marker = path.join(outside, "keep-me.txt");
    fs.writeFileSync(marker, "safe\n");

    const ok = await removeWorktree(repo, outside, wtRoot);

    expect(ok).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.readFileSync(marker, "utf8")).toBe("safe\n");
  });

  it("removeWorktree still removes a managed worktree and returns true", async () => {
    const repo = initRepo();
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-root-"));
    tmpDirs.push(wtRoot);
    const created = await createManagedWorktree({
      repoRoot: repo,
      worktreesRoot: wtRoot,
      tool: "grok_implement",
      name: "remove-ok",
    });
    expect(fs.existsSync(created.worktreePath)).toBe(true);
    const ok = await removeWorktree(repo, created.worktreePath, wtRoot);
    expect(ok).toBe(true);
    expect(fs.existsSync(created.worktreePath)).toBe(false);
  });

  it("removeWorktree deletes the codex-grok/<name> branch after removal", async () => {
    const repo = initRepo();
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-root-"));
    tmpDirs.push(wtRoot);
    const name = "branch-cleanup";
    const created = await createManagedWorktree({
      repoRoot: repo,
      worktreesRoot: wtRoot,
      tool: "grok_implement",
      name,
    });
    expect(created.branch).toBe(`codex-grok/${name}`);
    // Branch exists while worktree is live
    const before = execFileSync("git", ["branch", "--list", created.branch], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(before).toContain(created.branch);

    const ok = await removeWorktree(repo, created.worktreePath, wtRoot);
    expect(ok).toBe(true);
    expect(fs.existsSync(created.worktreePath)).toBe(false);

    const after = execFileSync("git", ["branch", "--list", created.branch], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(after.trim()).toBe("");
  });

  it("removeWorktree still refuses unregistered paths and does not delete branches", async () => {
    const repo = initRepo();
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-wt-root-"));
    tmpDirs.push(wtRoot);
    // Create a real managed branch/worktree, then try to remove a fake path
    // that should not trigger any branch delete.
    const created = await createManagedWorktree({
      repoRoot: repo,
      worktreesRoot: wtRoot,
      tool: "grok_implement",
      name: "keep-branch",
    });
    const fake = path.join(wtRoot, "not-registered");
    fs.mkdirSync(fake, { recursive: true });

    const refused = await removeWorktree(repo, fake, wtRoot);
    expect(refused).toBe(false);

    expect(fs.existsSync(created.worktreePath)).toBe(true);
    const stillThere = execFileSync(
      "git",
      ["branch", "--list", created.branch],
      { cwd: repo, encoding: "utf8" },
    );
    expect(stillThere).toContain(created.branch);

    const cleaned = await removeWorktree(repo, created.worktreePath, wtRoot);
    expect(cleaned).toBe(true);
  });
});
