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
  it("collects full tracked diff without per-path argv expansion", async () => {
    const repo = initRepo();
    // Many tracked changes — path-list argv expansion is what we avoid.
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(repo, `f${i}.txt`), `base-${i}\n`);
    }
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "many files"], { cwd: repo });
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(repo, `f${i}.txt`), `changed-${i}\n`);
    }
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");

    const result = await assembleDiff(repo, secretCfg, {
      maxUntrackedFileBytes: 500_000,
    });

    expect(result.changedFiles).toContain("f0.txt");
    expect(result.changedFiles).not.toContain(".env");
    expect(result.diff).toContain("changed-0");
    expect(result.diff).toContain("changed-19");
    expect(result.diff).not.toContain("SECRET=1");
    expect(result.warnings).toContain("REDACTED_SECRET_PATHS");
    expect(result.complete).toBe(false);
  });

  it("marks complete=false for secret-only tracked changes (empty usable patch)", async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, ".env"), "PLACEHOLDER=1\n");
    execFileSync("git", ["add", ".env"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "secret"], { cwd: repo });
    fs.writeFileSync(path.join(repo, ".env"), "PLACEHOLDER=2\n");

    const result = await assembleDiff(repo, secretCfg, {
      maxUntrackedFileBytes: 500_000,
    });
    expect(result.complete).toBe(false);
    expect(result.warnings).toContain("REDACTED_SECRET_PATHS");
    expect(result.diff).not.toContain("PLACEHOLDER");
    expect(result.changedFiles).not.toContain(".env");
  });

  it("marks complete=false when an untracked path cannot produce a patch", async () => {
    const repo = initRepo();
    const missingTarget = path.join(repo, "definitely-missing-target");
    const link = path.join(repo, "broken-untracked");
    // Dangling symlink: status usually lists it; stat/read fails closed.
    fs.symlinkSync(missingTarget, link);

    const result = await assembleDiff(repo, secretCfg, {
      maxUntrackedFileBytes: 500_000,
    });
    if (result.changedFiles.includes("broken-untracked")) {
      expect(result.complete).toBe(false);
      expect(
        result.warnings.some((w) =>
          ["UNTRACKED_DIFF_FAILED", "UNTRACKED_NON_FILE_SKIPPED"].includes(w),
        ),
      ).toBe(true);
    } else {
      // Some git/status configurations omit broken symlinks from -uall.
      expect(result.complete).toBe(true);
    }
  });

  it("includes untracked files with apply-friendly relative headers", () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, "newfile.txt"), "content-a\n");

    const asm = assembleDiff(
      repo,
      { secretBasenames: [".env"], aggressive: false },
      { maxUntrackedFileBytes: 500_000 },
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
      { maxUntrackedFileBytes: 500_000 },
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

    const result = await assembleDiff(repo, secretCfg, { maxUntrackedFileBytes: 500_000 });

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

  it("marks a modified tracked binary as incomplete (BINARY_SKIPPED)", async () => {
    const repo = initRepo();
    // NUL byte → git treats the file as binary.
    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    execFileSync("git", ["add", "blob.bin"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "add binary"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0x00, 0xff, 0xfe, 0xfd]));

    const result = await assembleDiff(repo, secretCfg, { maxUntrackedFileBytes: 500_000 });

    expect(result.complete).toBe(false);
    expect(result.warnings).toContain("BINARY_SKIPPED");
    expect(result.changedFiles).toContain("blob.bin");
    // Marker is still in the patch (content is not embedded); completeness flags it.
    expect(result.diff).toMatch(/^Binary files .+ and .+ differ$/m);
  });

  it("keeps complete=true for tracked text-only changes (no BINARY_SKIPPED)", async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, "README.md"), "hello world\n");

    const result = await assembleDiff(repo, secretCfg, { maxUntrackedFileBytes: 500_000 });

    expect(result.complete).toBe(true);
    expect(result.warnings).not.toContain("BINARY_SKIPPED");
    expect(result.warnings).not.toContain("REDACTED_SECRET_CONTENT");
    expect(result.diff).toContain("hello world");
  });

  it("marks complete=false when content redaction rewrites a tracked change", async () => {
    const repo = initRepo();
    // Obviously fake credential — must not survive in the assembled patch.
    const fakeSecret = "sk-abcdefghijklmnopqrstuvwxyz";
    fs.writeFileSync(
      path.join(repo, "app.ts"),
      `export const apiKey = "${fakeSecret}";\n`,
    );
    execFileSync("git", ["add", "app.ts"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "add app"], { cwd: repo });
    fs.writeFileSync(
      path.join(repo, "app.ts"),
      `export const apiKey = "${fakeSecret}";\nexport const n = 2;\n`,
    );

    const result = await assembleDiff(repo, secretCfg, { maxUntrackedFileBytes: 500_000 });

    expect(result.complete).toBe(false);
    expect(result.warnings).toContain("REDACTED_SECRET_CONTENT");
    expect(result.warnings).not.toContain("REDACTED_SECRET_PATHS");
    expect(result.diff).toContain("[REDACTED]");
    expect(result.diff).not.toContain(fakeSecret);
    expect(result.changedFiles).toContain("app.ts");
  });

  it("does not treat a text line containing the binary marker as incomplete", async () => {
    const repo = initRepo();
    // The marker appears only as an *added* body line (+…), not as a git header marker.
    fs.writeFileSync(
      path.join(repo, "notes.txt"),
      "Binary files a/x and b/x differ\n",
    );
    execFileSync("git", ["add", "notes.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "add notes"], { cwd: repo });
    fs.writeFileSync(
      path.join(repo, "notes.txt"),
      "Binary files a/x and b/x differ\n+Binary files a/x and b/x differ\n",
    );

    const result = await assembleDiff(repo, secretCfg, { maxUntrackedFileBytes: 500_000 });

    expect(result.complete).toBe(true);
    expect(result.warnings).not.toContain("BINARY_SKIPPED");
    // Body content still present (with the usual '+' prefix on the added line).
    expect(result.diff).toContain("Binary files a/x and b/x differ");
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

  it("reports complete=false and warnings when secret paths are filtered", async () => {
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, "normal.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(repo, ".env"), "PLACEHOLDER_ENV=base\n");
    execFileSync("git", ["add", "normal.ts", ".env"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

    fs.writeFileSync(path.join(repo, "normal.ts"), "export const a = 2;\n");
    fs.writeFileSync(path.join(repo, ".env"), "PLACEHOLDER_ENV=tip\n");
    execFileSync("git", ["add", "normal.ts", ".env"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "tip"], { cwd: repo });

    const result = await getDiffVsRef(repo, baseSha, 1_000_000, secretCfg);
    expect(result.empty).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.warnings).toContain("REDACTED_SECRET_PATHS");
    expect(result.diff).toContain("normal.ts");
    expect(result.diff).not.toContain(".env");
  });

  it("does not expand per-path argv for large change sets", async () => {
    const repo = initRepo();
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(repo, `n${i}.ts`), `export const n = ${i};\n`);
    }
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base many"], { cwd: repo });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(repo, `n${i}.ts`), `export const n = ${i + 1};\n`);
    }
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "tip many"], { cwd: repo });

    const result = await getDiffVsRef(repo, baseSha, 5_000_000, secretCfg);
    expect(result.empty).toBe(false);
    expect(result.complete).toBe(true);
    expect(result.diff).toContain("n0.ts");
    expect(result.diff).toContain("n29.ts");
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
