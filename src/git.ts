import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { GrokMcpError } from "./errors.js";
import type { RedactConfig } from "./redact.js";
import { filterSecretPaths, isSecretPath, redactText } from "./redact.js";

export interface RunGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runGit(
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<RunGitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`git ${args[0]} timed out`));
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

export async function getRepoRoot(cwd: string): Promise<string> {
  const r = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (r.exitCode !== 0) {
    throw new GrokMcpError(
      "GROK_MCP_NOT_A_GIT_REPO",
      `Not a git repository: ${cwd}. write_worktree requires a git repository; init git or use grok_analyze.`,
      { stderr_tail: r.stderr.slice(-500) },
    );
  }
  return path.resolve(r.stdout.trim());
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await getRepoRoot(cwd);
    return true;
  } catch {
    return false;
  }
}

export async function gitStatusPorcelain(cwd: string): Promise<string> {
  const r = await runGit(["status", "--porcelain=v1", "-uall"], cwd);
  if (r.exitCode !== 0) {
    throw new Error(`git status failed: ${r.stderr}`);
  }
  return r.stdout;
}

export function parsePorcelainPaths(porcelain: string): {
  all: string[];
  untracked: string[];
  trackedChanged: string[];
} {
  const all: string[] = [];
  const untracked: string[] = [];
  const trackedChanged: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line || line.length < 4) continue;
    const xy = line.slice(0, 2);
    let filePath = line.slice(3);
    // rename: "R  old -> new"
    if (filePath.includes(" -> ")) {
      filePath = filePath.split(" -> ").pop()!.trim();
    }
    // quoted paths
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = JSON.parse(filePath) as string;
    }
    all.push(filePath);
    if (xy === "??") untracked.push(filePath);
    else trackedChanged.push(filePath);
  }
  return { all, untracked, trackedChanged };
}

function isBinaryBuffer(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  return sample.includes(0);
}

function normalizeNewFilePatch(patch: string, relpath: string): string {
  // Force apply-friendly relative headers
  const posix = relpath.split(path.sep).join("/");
  const lines = patch.split("\n");
  const out: string[] = [];
  let sawDiff = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      out.push(`diff --git a/${posix} b/${posix}`);
      sawDiff = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      out.push("--- /dev/null");
      continue;
    }
    if (line.startsWith("+++ ")) {
      out.push(`+++ b/${posix}`);
      continue;
    }
    // skip index lines that are fine as-is
    out.push(line);
  }
  if (!sawDiff && patch.trim()) {
    return [
      `diff --git a/${posix} b/${posix}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${posix}`,
      ...out,
    ].join("\n");
  }
  return out.join("\n");
}

export interface DiffAssembly {
  changedFiles: string[];
  diff: string;
  warnings: string[];
}

export async function assembleDiff(
  effectiveCwd: string,
  redactCfg: RedactConfig,
  opts: {
    maxDiffBytes: number;
    maxUntrackedFileBytes: number;
  },
): Promise<DiffAssembly> {
  const warnings: string[] = [];
  let gitRoot: string;
  try {
    gitRoot = await getRepoRoot(effectiveCwd);
  } catch {
    return { changedFiles: [], diff: "", warnings: ["NOT_A_GIT_REPO_FOR_DIFF"] };
  }

  const porcelain = await gitStatusPorcelain(gitRoot);
  const parsed = parsePorcelainPaths(porcelain);
  const { kept, redacted } = filterSecretPaths(parsed.all, redactCfg);
  if (redacted.length) warnings.push("REDACTED_SECRET_PATHS");

  // Tracked diff
  const tracked = await runGit(["diff", "HEAD"], gitRoot);
  // exit 0 or 1 both OK
  let diffParts: string[] = [];
  if (tracked.stdout.trim()) {
    diffParts.push(tracked.stdout.replace(/\n?$/, "\n"));
  }

  const untrackedKept = parsed.untracked.filter((p) => kept.includes(p));
  for (const rel of untrackedKept) {
    if (rel.includes("..") || path.isAbsolute(rel)) {
      warnings.push("PATH_ESCAPE_SKIPPED");
      continue;
    }
    const abs = path.join(gitRoot, rel);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) continue;
      if (st.size > opts.maxUntrackedFileBytes) {
        warnings.push("UNTRACKED_TOO_LARGE");
        continue;
      }
      const buf = await fs.readFile(abs);
      if (isBinaryBuffer(buf)) {
        warnings.push("BINARY_SKIPPED");
        continue;
      }
      if (isSecretPath(rel, redactCfg)) continue;

      const patch = await runGit(
        ["diff", "--no-index", "--", "/dev/null", rel],
        gitRoot,
      );
      // git returns 1 when files differ
      if (patch.stdout.trim()) {
        diffParts.push(normalizeNewFilePatch(patch.stdout, rel).replace(/\n?$/, "\n"));
      }
    } catch {
      warnings.push("UNTRACKED_DIFF_FAILED");
    }
  }

  let diff = redactText(diffParts.join(""));
  if (Buffer.byteLength(diff, "utf8") > opts.maxDiffBytes) {
    // truncate
    let truncated = diff;
    while (
      Buffer.byteLength(truncated, "utf8") > opts.maxDiffBytes - 40 &&
      truncated.length > 0
    ) {
      truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
    }
    diff = `${truncated}\n... [diff truncated]`;
    warnings.push("DIFF_TRUNCATED");
  }

  return {
    changedFiles: kept,
    diff,
    warnings: [...new Set(warnings)],
  };
}

export async function getDiffVsRef(
  cwd: string,
  baseRef: string,
  maxBytes: number,
  _redactCfg: RedactConfig,
): Promise<{ stat: string; diff: string; empty: boolean }> {
  const root = await getRepoRoot(cwd);
  const statR = await runGit(["diff", "--stat", baseRef], root);
  const diffR = await runGit(["diff", baseRef], root);
  let diff = redactText(diffR.stdout || "");
  if (Buffer.byteLength(diff, "utf8") > maxBytes) {
    let truncated = diff;
    while (Buffer.byteLength(truncated, "utf8") > maxBytes - 40 && truncated.length) {
      truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
    }
    diff = `${truncated}\n... [diff truncated]`;
  }
  return {
    stat: redactText(statR.stdout || ""),
    diff,
    empty: !diffR.stdout.trim(),
  };
}

export function statusChanged(before: string, after: string): boolean {
  return before.trim() !== after.trim();
}
