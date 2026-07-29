import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleDiff } from "../../src/git.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function initRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-git-"));
  tmpDirs.push(d);
  execFileSync("git", ["init"], { cwd: d });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: d });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: d });
  fs.writeFileSync(path.join(d, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: d });
  execFileSync("git", ["commit", "-m", "init"], { cwd: d });
  return d;
}

describe("assembleDiff", () => {
  it("includes untracked files with apply-friendly relative headers", () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, "newfile.txt"), "content-a\n");

    const asm = assembleDiff(
      repo,
      { secretBasenames: [".env"], aggressive: false },
      { maxDiffBytes: 1_000_000, maxUntrackedFileBytes: 500_000 },
    );

    return asm.then((result) => {
      expect(result.changedFiles).toContain("newfile.txt");
      expect(result.diff).toContain("diff --git a/newfile.txt b/newfile.txt");
      expect(result.diff).toContain("+++ b/newfile.txt");
      expect(result.diff).not.toMatch(/\/var\/folders|\/tmp\//);

      // Apply into second clean worktree
      const clone = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-apply-"));
      tmpDirs.push(clone);
      execFileSync("git", ["clone", repo, clone]);
      fs.writeFileSync(path.join(clone, "patch.diff"), result.diff);
      execFileSync("git", ["apply", "patch.diff"], { cwd: clone });
      expect(fs.readFileSync(path.join(clone, "newfile.txt"), "utf8")).toBe(
        "content-a\n",
      );
    });
  });

  it("redacts secret paths from changed_files", async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
    fs.writeFileSync(path.join(repo, "ok.ts"), "export {}\n");
    const result = await assembleDiff(
      repo,
      { secretBasenames: [".env"], aggressive: false },
      { maxDiffBytes: 1_000_000, maxUntrackedFileBytes: 500_000 },
    );
    expect(result.changedFiles).toContain("ok.ts");
    expect(result.changedFiles).not.toContain(".env");
    expect(result.warnings).toContain("REDACTED_SECRET_PATHS");
  });
});
