import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assembleDiff,
  filterSecretDiffHunks,
  safeGitDiffArgs,
} from "../../src/git.js";

const tmpDirs: string[] = [];
const secretCfg = {
  secretBasenames: [".env", "auth.json"],
  aggressive: false,
};

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-git-security-"));
  tmpDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

describe("safe git diff collection", () => {
  it("always disables external diff drivers and textconv", () => {
    expect(safeGitDiffArgs("HEAD", "--")).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "HEAD",
      "--",
    ]);
  });

  it("does not execute a repository-configured textconv command", async () => {
    const repo = initRepo();
    const marker = path.join(repo, "textconv-ran");
    const filter = path.join(repo, "evil-textconv.sh");
    fs.writeFileSync(
      filter,
      `#!/bin/sh\necho invoked >> ${JSON.stringify(marker)}\ncat "$1"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(repo, ".gitattributes"), "payload.txt diff=evil\n");
    fs.writeFileSync(path.join(repo, "payload.txt"), "before\n");
    execFileSync("git", ["add", ".gitattributes", "payload.txt", "evil-textconv.sh"], {
      cwd: repo,
    });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
    execFileSync("git", ["config", "diff.evil.textconv", filter], { cwd: repo });

    fs.writeFileSync(path.join(repo, "payload.txt"), "after\n");
    const result = await assembleDiff(repo, secretCfg, {
      maxUntrackedFileBytes: 500_000,
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(result.diff).toContain("after");
  });
});

describe("secret path filtering with spaces", () => {
  it("parses an unquoted diff header containing spaces", () => {
    const diff = [
      "diff --git a/dir with space/.env b/dir with space/.env",
      "index 1111111..2222222 100644",
      "--- a/dir with space/.env",
      "+++ b/dir with space/.env",
      "@@ -1 +1 @@",
      "-TOKEN=before",
      "+TOKEN=after",
      "",
    ].join("\n");

    const filtered = filterSecretDiffHunks(diff, secretCfg);
    expect(filtered.redactedAny).toBe(true);
    expect(filtered.unparseableAny).toBe(false);
    expect(filtered.diff).toBe("");
  });

  it("omits a tracked .env below a directory whose name contains spaces", async () => {
    const repo = initRepo();
    const nested = path.join(repo, "dir with space");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, ".env"), "PLACEHOLDER_SECRET=before\n");
    fs.writeFileSync(path.join(repo, "app.ts"), "export const n = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });

    fs.writeFileSync(path.join(nested, ".env"), "PLACEHOLDER_SECRET=after\n");
    fs.writeFileSync(path.join(repo, "app.ts"), "export const n = 2;\n");

    const result = await assembleDiff(repo, secretCfg, {
      maxUntrackedFileBytes: 500_000,
    });

    expect(result.changedFiles).toContain("app.ts");
    expect(result.changedFiles).not.toContain("dir with space/.env");
    expect(result.diff).toContain("export const n = 2");
    expect(result.diff).not.toContain(".env");
    expect(result.diff).not.toContain("PLACEHOLDER_SECRET");
    expect(result.warnings).toContain("REDACTED_SECRET_PATHS");
    expect(result.complete).toBe(false);
  });
});
