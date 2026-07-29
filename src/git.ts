import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { GrokMcpError } from "./errors.js";
import { scrubEnv } from "./grok-runner.js";
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
      // Scrub secrets from the child env (same policy as Grok / test_command).
      env: { ...scrubEnv(), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
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

/** Unquote a git path token (e.g. `"foo bar"` or plain `foo`). */
function unquoteGitPath(token: string): string {
  const t = token.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

/**
 * Extract file path(s) from a unified-diff header line.
 * Handles `diff --git a/X b/Y`, `--- a/X`, `+++ b/X`, and plain stat lines.
 */
function pathsFromDiffHeaderLine(line: string): string[] {
  if (line.startsWith("diff --git ")) {
    const rest = line.slice("diff --git ".length);
    // Prefer split on " b/" then strip a/ from first; quoted paths use JSON quotes
    const m = rest.match(/^(?:"(?:\\.|[^"])*"|[^\s]+)\s+(?:"(?:\\.|[^"])*"|[^\s]+)$/);
    if (!m) return [];
    const parts = rest.match(/"(?:\\.|[^"])*"|[^\s]+/g) ?? [];
    return parts.map((p) => {
      let s = unquoteGitPath(p);
      if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
      return s;
    });
  }
  if (line.startsWith("--- ") || line.startsWith("+++ ")) {
    let p = line.slice(4).trim();
    if (p === "/dev/null") return [];
    p = unquoteGitPath(p);
    if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
    return p ? [p] : [];
  }
  return [];
}

/**
 * Drop whole-file hunks whose paths are secret basenames.
 * Remaining hunks stay apply-friendly (headers unchanged for kept files).
 */
export function filterSecretDiffHunks(
  diff: string,
  cfg: RedactConfig,
): { diff: string; redactedAny: boolean } {
  if (!diff.trim()) return { diff: "", redactedAny: false };
  const lines = diff.split("\n");
  const keptChunks: string[][] = [];
  let current: string[] | null = null;
  let currentIsSecret = false;
  let redactedAny = false;
  let preamble: string[] = [];

  const flush = () => {
    if (current == null) return;
    if (currentIsSecret) redactedAny = true;
    else keptChunks.push(current);
    current = null;
    currentIsSecret = false;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      // any preamble before first diff goes with first chunk decision
      current = preamble.length ? [...preamble, line] : [line];
      preamble = [];
      const paths = pathsFromDiffHeaderLine(line);
      currentIsSecret = paths.some((p) => isSecretPath(p, cfg));
      continue;
    }
    if (current == null) {
      preamble.push(line);
      continue;
    }
    current.push(line);
  }
  flush();

  // If there was only preamble (no diff --git), treat as opaque text
  if (keptChunks.length === 0 && preamble.length && !redactedAny) {
    return { diff: preamble.join("\n"), redactedAny: false };
  }

  let out = keptChunks.map((c) => c.join("\n")).join("\n");
  if (out && !out.endsWith("\n") && diff.endsWith("\n")) out += "\n";
  return { diff: out, redactedAny };
}

/**
 * Best-effort insertions/deletions from a `git diff --stat` file row.
 * Uses the histogram bar after `|`; when scaled, distributes the numeric total
 * proportionally across `+`/`-` characters.
 */
function countsFromStatRow(line: string): { insertions: number; deletions: number } {
  const pipe = line.lastIndexOf("|");
  if (pipe < 0) return { insertions: 0, deletions: 0 };
  const right = line.slice(pipe + 1).trim();
  if (/^Bin\b/i.test(right)) return { insertions: 0, deletions: 0 };
  const m = right.match(/^(\d+)\s*(.*)$/);
  if (!m) return { insertions: 0, deletions: 0 };
  const total = Number.parseInt(m[1]!, 10);
  const bar = m[2] ?? "";
  const plus = (bar.match(/\+/g) ?? []).length;
  const minus = (bar.match(/-/g) ?? []).length;
  if (plus + minus === 0) return { insertions: 0, deletions: 0 };
  if (plus + minus === total || total === 0) {
    return { insertions: plus, deletions: minus };
  }
  // Scaled bar: apportion the numeric total by bar ratio.
  const ratio = total / (plus + minus);
  const insertions = Math.round(plus * ratio);
  return { insertions, deletions: total - insertions };
}

function formatStatSummary(
  fileRows: number,
  insertions: number,
  deletions: number,
  secretOmitted: boolean,
): string {
  let summary = ` ${fileRows} file${fileRows === 1 ? "" : "s"} changed`;
  if (insertions > 0) {
    summary += `, ${insertions} insertion${insertions === 1 ? "" : "s"}(+)`;
  }
  if (deletions > 0) {
    summary += `, ${deletions} deletion${deletions === 1 ? "" : "s"}(-)`;
  }
  if (secretOmitted) summary += " (secret paths omitted)";
  return summary;
}

/**
 * Drop secret-path rows from `git diff --stat` output.
 * Summary line keeps insertion/deletion counts from retained rows; the
 * `(secret paths omitted)` qualifier is only appended when something was removed.
 */
export function filterSecretStatLines(
  stat: string,
  cfg: RedactConfig,
): { stat: string; redactedAny: boolean } {
  if (!stat.trim()) return { stat: "", redactedAny: false };
  const lines = stat.split("\n");
  const kept: string[] = [];
  let redactedAny = false;
  let fileRows = 0;
  let insertions = 0;
  let deletions = 0;
  let originalSummary: string | null = null;

  for (const line of lines) {
    // Summary: " N files changed, ..."
    if (/^\s*\d+\s+files? changed/.test(line)) {
      originalSummary = line;
      continue; // recompute or restore below
    }
    // File row: " path/to/file | 12 +++---" (leading space optional)
    const m = line.match(/^\s*(.+?)\s+\|\s+/);
    if (m) {
      const filePath = m[1]!.trim();
      if (isSecretPath(filePath, cfg)) {
        redactedAny = true;
        continue;
      }
      kept.push(line);
      fileRows += 1;
      const c = countsFromStatRow(line);
      insertions += c.insertions;
      deletions += c.deletions;
      continue;
    }
    kept.push(line);
  }

  // Drop trailing empty-only noise then add a summary if we had file rows
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  if (fileRows > 0) {
    if (!redactedAny && originalSummary !== null) {
      // Nothing removed: keep git's original summary (with its counts).
      kept.push(originalSummary);
    } else {
      kept.push(formatStatSummary(fileRows, insertions, deletions, redactedAny));
    }
  }
  let out = kept.join("\n");
  if (out && stat.endsWith("\n")) out += "\n";
  return { stat: out, redactedAny };
}

/**
 * Validate base_ref before passing to git: no NUL, no leading dash (option injection).
 */
export function assertSafeBaseRef(baseRef: string): void {
  if (typeof baseRef !== "string" || baseRef.length === 0) {
    throw new GrokMcpError("GROK_MCP_INVALID_ARGS", "base_ref must be a non-empty string");
  }
  if (baseRef.includes("\0")) {
    throw new GrokMcpError(
      "GROK_MCP_INVALID_ARGS",
      "base_ref must not contain NUL bytes",
    );
  }
  if (/[\r\n]/.test(baseRef)) {
    throw new GrokMcpError(
      "GROK_MCP_INVALID_ARGS",
      "base_ref must not contain newlines",
    );
  }
  if (baseRef.startsWith("-")) {
    throw new GrokMcpError(
      "GROK_MCP_INVALID_ARGS",
      "base_ref must not start with '-' (option injection)",
    );
  }
}

/**
 * Verify base_ref is a commit-ish and return the resolved commit object name.
 * Uses `--end-of-options` so the ref cannot be parsed as a git option.
 * Rejects non-commit objects (blobs, trees, HEAD:path) — no arbitrary-object fallback.
 */
export async function verifyBaseRef(cwd: string, baseRef: string): Promise<string> {
  assertSafeBaseRef(baseRef);
  const r = await runGit(
    ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
    cwd,
  );
  if (r.exitCode !== 0) {
    throw new GrokMcpError(
      "GROK_MCP_INVALID_ARGS",
      `base_ref is not a valid commit-ish: ${baseRef}`,
      { stderr_tail: r.stderr.slice(-500) },
    );
  }
  return r.stdout.trim().split("\n")[0]!.trim();
}

export interface DiffAssembly {
  changedFiles: string[];
  diff: string;
  warnings: string[];
  /**
   * True when `diff` contains every change git reported for this tree.
   *
   * False when something was deliberately dropped during collection — secret
   * paths / hunks, an untracked file over `maxUntrackedFileBytes`, a binary or
   * unreadable untracked file, a path that escaped the repo root. Such a patch
   * must not be advertised as a complete, applyable representation of the change.
   *
   * An empty tree (or a non-git directory) is vacuously complete: nothing was
   * detected, so nothing was omitted.
   */
  complete: boolean;
}

/**
 * Collect the working-tree change as a single redacted patch.
 *
 * Pipeline (single path, no second diff source):
 *   git status/diff → secret-path & secret-hunk removal → content redaction.
 *
 * There is deliberately **no byte cap here**. `runGit` already buffers git's
 * entire stdout, so truncating afterwards costs the same peak memory while
 * silently corrupting the patch. Return-volume control belongs downstream in
 * `response_mode` (inline vs. artifact), which never mutates the patch body;
 * an opt-in absolute cap lives there and is reported via `diff_truncated`.
 */
export async function assembleDiff(
  effectiveCwd: string,
  redactCfg: RedactConfig,
  opts: {
    maxUntrackedFileBytes: number;
  },
): Promise<DiffAssembly> {
  const warnings: string[] = [];
  /** Set whenever a detected change is dropped from `diff`. */
  let omitted = false;
  let gitRoot: string;
  try {
    gitRoot = await getRepoRoot(effectiveCwd);
  } catch {
    return {
      changedFiles: [],
      diff: "",
      warnings: ["NOT_A_GIT_REPO_FOR_DIFF"],
      complete: true,
    };
  }

  const porcelain = await gitStatusPorcelain(gitRoot);
  const parsed = parsePorcelainPaths(porcelain);
  const { kept, redacted } = filterSecretPaths(parsed.all, redactCfg);
  if (redacted.length) {
    warnings.push("REDACTED_SECRET_PATHS");
    omitted = true;
  }

  // Tracked diff — then strip secret-path hunks (tracked .env etc. must not leak)
  const tracked = await runGit(["diff", "HEAD", "--"], gitRoot);
  // exit 0 or 1 both OK
  let diffParts: string[] = [];
  if (tracked.stdout.trim()) {
    const filtered = filterSecretDiffHunks(tracked.stdout, redactCfg);
    if (filtered.redactedAny) {
      warnings.push("REDACTED_SECRET_PATHS");
      omitted = true;
    }
    if (filtered.diff.trim()) {
      diffParts.push(filtered.diff.replace(/\n?$/, "\n"));
    }
  }

  const untrackedKept = parsed.untracked.filter((p) => kept.includes(p));
  for (const rel of untrackedKept) {
    if (rel.includes("..") || path.isAbsolute(rel)) {
      warnings.push("PATH_ESCAPE_SKIPPED");
      omitted = true;
      continue;
    }
    const abs = path.join(gitRoot, rel);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) continue;
      // Pre-read cap: checked against stat() size, so an oversized file is never
      // loaded into memory. This is real memory protection, unlike a post-hoc
      // cap on the assembled patch.
      if (st.size > opts.maxUntrackedFileBytes) {
        warnings.push("UNTRACKED_TOO_LARGE");
        omitted = true;
        continue;
      }
      const buf = await fs.readFile(abs);
      if (isBinaryBuffer(buf)) {
        warnings.push("BINARY_SKIPPED");
        omitted = true;
        continue;
      }
      if (isSecretPath(rel, redactCfg)) {
        omitted = true;
        continue;
      }

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
      omitted = true;
    }
  }

  // Content redaction is the last transform; the result is the canonical patch
  // that response_mode either inlines verbatim or writes to an artifact.
  const diff = redactText(diffParts.join(""));

  return {
    changedFiles: kept,
    diff,
    warnings: [...new Set(warnings)],
    complete: !omitted,
  };
}

export async function getDiffVsRef(
  cwd: string,
  baseRef: string,
  maxBytes: number,
  redactCfg: RedactConfig,
): Promise<{ stat: string; diff: string; empty: boolean }> {
  const root = await getRepoRoot(cwd);
  const verified = await verifyBaseRef(root, baseRef);

  // Resolved object name is hex (or similar) — never a leading-dash option.
  // Use `--` path separator after the revision for defense in depth.
  const nameR = await runGit(["diff", "--name-only", verified, "--"], root);
  const names = nameR.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const { kept, redacted } = filterSecretPaths(names, redactCfg);

  if (kept.length === 0) {
    return { stat: "", diff: "", empty: true };
  }

  // Prefer pathspecs so secret files never appear in git output at all.
  const statR = await runGit(["diff", "--stat", verified, "--", ...kept], root);
  const diffR = await runGit(["diff", verified, "--", ...kept], root);

  // Defense in depth: strip any secret hunks/stat rows that still slipped through
  // (e.g. renames involving a secret path, or pathspec edge cases).
  let filteredStat = filterSecretStatLines(statR.stdout || "", redactCfg).stat;
  let filteredDiff = filterSecretDiffHunks(diffR.stdout || "", redactCfg).diff;

  if (redacted.length) {
    // already omitted via pathspecs; keep empty marker free of secret names
  }

  let diff = redactText(filteredDiff);
  if (Buffer.byteLength(diff, "utf8") > maxBytes) {
    let truncated = diff;
    while (Buffer.byteLength(truncated, "utf8") > maxBytes - 40 && truncated.length) {
      truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
    }
    diff = `${truncated}\n... [diff truncated]`;
  }
  return {
    stat: redactText(filteredStat),
    diff,
    empty: !filteredDiff.trim(),
  };
}

export function statusChanged(before: string, after: string): boolean {
  return before.trim() !== after.trim();
}
