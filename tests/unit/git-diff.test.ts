import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrokMcpError } from "../../src/errors.js";
import {
  assembleDiff,
  filterSecretStatLines,
  getDiffVsRef,
  verifyBaseRef,
} from "../../src/git.js";

const tmpDirs: string[] = [];

const secretCfg = {
  secretBasenames: [".env", "auth.json"],
  aggressive: false,
};

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

  it("omits tracked .env and auth.json from changed_files and diff", async () => {
    const repo = initRepo();
    // Innocuous placeholder values — must not appear in assembleDiff output
    fs.writeFileSync(path.join(repo, ".env"), "PLACEHOLDER_ENV=innocuous\n");
    fs.writeFileSync(
      path.join(repo, "auth.json"),
      JSON.stringify({ token: "innocuous-token-value" }) + "\n",
    );
    fs.writeFileSync(path.join(repo, "app.ts"), "export const n = 1;\n");
    execFileSync("git", ["add", ".env", "auth.json", "app.ts"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "add secrets and app"], { cwd: repo });

    // Modify tracked files so they show in git diff HEAD
    fs.writeFileSync(path.join(repo, ".env"), "PLACEHOLDER_ENV=changed-innocuous\n");
    fs.writeFileSync(
      path.join(repo, "auth.json"),
      JSON.stringify({ token: "changed-innocuous-token" }) + "\n",
    );
    fs.writeFileSync(path.join(repo, "app.ts"), "export const n = 2;\n");

    const result = await assembleDiff(repo, secretCfg, {
      maxDiffBytes: 1_000_000,
      maxUntrackedFileBytes: 500_000,
    });

    expect(result.changedFiles).toContain("app.ts");
    expect(result.changedFiles).not.toContain(".env");
    expect(result.changedFiles).not.toContain("auth.json");
    expect(result.warnings).toContain("REDACTED_SECRET_PATHS");

    expect(result.diff).toContain("app.ts");
    expect(result.diff).toContain("export const n = 2");
    expect(result.diff).not.toContain(".env");
    expect(result.diff).not.toContain("auth.json");
    expect(result.diff).not.toContain("PLACEHOLDER_ENV");
    expect(result.diff).not.toContain("innocuous");
    expect(result.diff).not.toContain("changed-innocuous");
  });
});

describe("getDiffVsRef", () => {
  it("omits secret paths/content from diff and stat while keeping normal files", async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, "normal.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(repo, ".env"), "PLACEHOLDER_ENV=base-innocuous\n");
    fs.writeFileSync(
      path.join(repo, "auth.json"),
      JSON.stringify({ token: "base-innocuous-token" }) + "\n",
    );
    execFileSync("git", ["add", "normal.ts", ".env", "auth.json"], {
      cwd: repo,
    });
    execFileSync("git", ["commit", "-m", "base with secrets"], { cwd: repo });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

    fs.writeFileSync(path.join(repo, "normal.ts"), "export const a = 2;\n");
    fs.writeFileSync(path.join(repo, ".env"), "PLACEHOLDER_ENV=tip-innocuous\n");
    fs.writeFileSync(
      path.join(repo, "auth.json"),
      JSON.stringify({ token: "tip-innocuous-token" }) + "\n",
    );
    fs.writeFileSync(path.join(repo, "extra.ts"), "export const b = 1;\n");
    execFileSync("git", ["add", "normal.ts", ".env", "auth.json", "extra.ts"], {
      cwd: repo,
    });
    execFileSync("git", ["commit", "-m", "tip changes"], { cwd: repo });

    const result = await getDiffVsRef(repo, baseSha, 1_000_000, secretCfg);

    expect(result.empty).toBe(false);
    expect(result.diff).toContain("normal.ts");
    expect(result.diff).toContain("extra.ts");
    expect(result.diff).toContain("export const a = 2");
    expect(result.diff).not.toContain(".env");
    expect(result.diff).not.toContain("auth.json");
    expect(result.diff).not.toContain("PLACEHOLDER_ENV");
    expect(result.diff).not.toContain("innocuous");
    expect(result.diff).not.toContain("tip-innocuous");

    expect(result.stat).toMatch(/normal\.ts|extra\.ts/);
    expect(result.stat).not.toContain(".env");
    expect(result.stat).not.toContain("auth.json");
    expect(result.stat).not.toContain("PLACEHOLDER_ENV");
  });

  it("rejects base_ref beginning with --", async () => {
    const repo = initRepo();
    await expect(
      getDiffVsRef(repo, "--output=/tmp/x", 1_000_000, secretCfg),
    ).rejects.toMatchObject({
      code: "GROK_MCP_INVALID_ARGS",
    });
    await expect(
      getDiffVsRef(repo, "--output=/tmp/x", 1_000_000, secretCfg),
    ).rejects.toBeInstanceOf(GrokMcpError);
  });

  it("rejects nonexistent refs", async () => {
    const repo = initRepo();
    await expect(
      getDiffVsRef(repo, "definitely-not-a-real-ref-xyz", 1_000_000, secretCfg),
    ).rejects.toMatchObject({
      code: "GROK_MCP_INVALID_ARGS",
    });
  });
});

describe("filterSecretStatLines", () => {
  it("keeps original summary counts when nothing is redacted", () => {
    const stat = [
      " normal.ts | 2 +-",
      " extra.ts  | 1 +",
      " 2 files changed, 2 insertions(+), 1 deletion(-)",
      "",
    ].join("\n");
    const result = filterSecretStatLines(stat, secretCfg);
    expect(result.redactedAny).toBe(false);
    expect(result.stat).toContain("normal.ts");
    expect(result.stat).toContain("extra.ts");
    expect(result.stat).toContain("2 files changed, 2 insertions(+), 1 deletion(-)");
    expect(result.stat).not.toContain("secret paths omitted");
  });

  it("recomputes counts and marks omission when secret paths are dropped", () => {
    const stat = [
      " normal.ts | 2 +-",
      " .env      | 1 +",
      " 2 files changed, 2 insertions(+), 1 deletion(-)",
      "",
    ].join("\n");
    const result = filterSecretStatLines(stat, secretCfg);
    expect(result.redactedAny).toBe(true);
    expect(result.stat).toContain("normal.ts");
    expect(result.stat).not.toContain(".env");
    expect(result.stat).toMatch(/1 file changed/);
    expect(result.stat).toMatch(/1 insertion\(\+\)/);
    expect(result.stat).toMatch(/1 deletion\(-\)/);
    expect(result.stat).toContain("(secret paths omitted)");
  });
});

describe("verifyBaseRef", () => {
  it("accepts commit-ish refs", async () => {
    const repo = initRepo();
    const sha = await verifyBaseRef(repo, "HEAD");
    expect(sha).toMatch(/^[0-9a-f]{40,}$/i);
  });

  it("rejects base_ref beginning with --", async () => {
    const repo = initRepo();
    await expect(verifyBaseRef(repo, "--all")).rejects.toBeInstanceOf(
      GrokMcpError,
    );
    await expect(verifyBaseRef(repo, "--all")).rejects.toMatchObject({
      code: "GROK_MCP_INVALID_ARGS",
      message: expect.stringMatching(/must not start with/i),
    });
  });

  it("rejects nonexistent refs", async () => {
    const repo = initRepo();
    await expect(
      verifyBaseRef(repo, "no-such-ref-abc123"),
    ).rejects.toMatchObject({
      code: "GROK_MCP_INVALID_ARGS",
      message: expect.stringMatching(/commit-ish|valid/i),
    });
  });

  it("rejects blob/path objects (HEAD:path) — commit-ish only", async () => {
    const repo = initRepo();
    // HEAD:README.md resolves as a blob, not a commit
    await expect(verifyBaseRef(repo, "HEAD:README.md")).rejects.toMatchObject({
      code: "GROK_MCP_INVALID_ARGS",
      message: expect.stringMatching(/commit-ish|valid/i),
    });
  });
});
