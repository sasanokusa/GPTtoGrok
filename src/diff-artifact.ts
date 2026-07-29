/**
 * Response-mode plumbing: diff sizing, artifact persistence, and artifact GC.
 *
 * Invariant: every function here consumes the **already redacted** diff string
 * produced by {@link import("./git.js").assembleDiff} (secret-path hunks removed,
 * content regexes applied, capped at `maxDiffBytes`). There is deliberately no
 * second diff-collection path — an artifact can only ever hold the same bytes
 * that `response_mode: "full"` would have inlined.
 */

import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { GrokMcpError } from "./errors.js";
import { logger } from "./log.js";
import { normalizeForCompare } from "./path-guard.js";

export type ResponseMode = "auto" | "full" | "compact" | "summary_only";
export type EffectiveResponseMode = "full" | "compact" | "summary_only";

export interface DiffStats {
  files_changed: number;
  insertions: number;
  deletions: number;
}

/** Directory name = 16 hex chars of a SHA-256 scope digest (never raw caller input). */
const ARTIFACT_DIR_RE = /^[0-9a-f]{16}$/;
/** File name = `<uuid v4>.diff`. */
const ARTIFACT_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.diff$/;
/** In-flight temp file written by {@link writeDiffArtifact} before rename. */
const ARTIFACT_TMP_RE =
  /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp-\d+-[0-9a-f]{8}$/;

/** `true` if `child` is strictly inside `parent` (never equal). */
function isStrictlyUnder(child: string, parent: string): boolean {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  if (c === p) return false;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Managed root for diff artifacts. Always inside the server cache dir. */
export function diffArtifactsRoot(cacheDir: string): string {
  return path.join(cacheDir, "diffs");
}

/**
 * Stable, collision-free directory name for a session / worktree scope.
 * Hashed so a Grok-supplied session id is never concatenated into a path.
 */
export function artifactScopeHash(scope: string): string {
  return crypto.createHash("sha256").update(scope).digest("hex").slice(0, 16);
}

/** SHA-256 (hex) of the redacted diff body that is returned or stored. */
export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Structured stats for the redacted patch body.
 *
 * Counts are derived from the patch itself (not `git diff --stat` text) so they
 * always describe exactly what was returned or written to the artifact.
 * `files_changed` counts `diff --git` headers, so it can be lower than
 * `changed_files.length` when binary / oversized untracked files were skipped.
 *
 * Scans by index rather than `split("\n")` to avoid copying a large diff.
 */
export function computeDiffStats(diff: string): DiffStats {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  const len = diff.length;
  let i = 0;
  while (i < len) {
    const nl = diff.indexOf("\n", i);
    const end = nl === -1 ? len : nl;
    const c = diff.charCodeAt(i);
    if (c === 43 /* + */) {
      // `+++ b/path` is a header, not an inserted line.
      if (!(diff.charCodeAt(i + 1) === 43 && diff.charCodeAt(i + 2) === 43)) {
        insertions++;
      }
    } else if (c === 45 /* - */) {
      if (!(diff.charCodeAt(i + 1) === 45 && diff.charCodeAt(i + 2) === 45)) {
        deletions++;
      }
    } else if (c === 100 /* d */ && diff.startsWith("diff --git ", i)) {
      files++;
    }
    if (nl === -1) break;
    i = end + 1;
  }
  return { files_changed: files, insertions, deletions };
}

export interface ResponseModeDecision {
  effective: EffectiveResponseMode;
  /** True when an explicit/auto `full` was downgraded by the hard inline cap. */
  hardLimitApplied: boolean;
}

/**
 * Decide the effective response mode from the redacted diff's UTF-8 byte length.
 *
 * - `summary_only` / `compact` are honoured verbatim.
 * - `auto` inlines while `diffBytes <= inlineMaxBytes`, else compact.
 * - `full` (explicit or chosen by auto) is downgraded to `compact` when the diff
 *   exceeds `inlineHardMaxBytes`. The diff is never silently truncated; callers
 *   surface `DIFF_HARD_LIMIT_APPLIED`.
 */
export function resolveEffectiveResponseMode(opts: {
  requested: ResponseMode;
  diffBytes: number;
  inlineMaxBytes: number;
  inlineHardMaxBytes: number;
}): ResponseModeDecision {
  if (opts.requested === "summary_only") {
    return { effective: "summary_only", hardLimitApplied: false };
  }
  if (opts.requested === "compact") {
    return { effective: "compact", hardLimitApplied: false };
  }

  const wantsInline =
    opts.requested === "full" || opts.diffBytes <= opts.inlineMaxBytes;
  if (!wantsInline) {
    return { effective: "compact", hardLimitApplied: false };
  }
  if (opts.diffBytes > opts.inlineHardMaxBytes) {
    return { effective: "compact", hardLimitApplied: true };
  }
  return { effective: "full", hardLimitApplied: false };
}

/** Short, structured follow-up hints for the parent agent (empty for `full`). */
export function buildNextActions(
  effective: EffectiveResponseMode,
  opts: { hasWorktree: boolean; diffRecoverable: boolean },
): string[] {
  if (effective === "full") return [];
  if (!opts.diffRecoverable) {
    // Nothing survives this call: no body, no artifact, no retained worktree.
    return [
      "Re-run with response_mode \"full\" or \"compact\" to obtain the patch",
      "Keep keep_worktree=true to inspect changes in the worktree",
    ];
  }
  const where = opts.hasWorktree ? "worktree_path" : "effective_cwd";
  const actions = [`Inspect changed_files under ${where}`];
  actions.push(
    effective === "compact"
      ? "Read diff_artifact_path for the full redacted patch"
      : 'Re-run with response_mode "compact" or "full" to obtain the patch',
  );
  actions.push("Run independent tests before applying changes");
  return actions;
}

export interface WriteDiffArtifactOpts {
  cacheDir: string;
  /** Session id, worktree path, or run id — hashed, never concatenated raw. */
  scope: string;
  /** UUID v4 allocated by the caller (unique per call → concurrency-safe). */
  artifactId: string;
  /** Redacted diff body. Must be the same string `full` would have inlined. */
  redactedDiff: string;
}

/**
 * Atomically persist a redacted diff under the managed cache root.
 *
 * Safety properties:
 * - Target directory / file names are generated (hex digest + UUID) and
 *   re-validated against strict regexes, so no caller input reaches the path.
 * - Both the artifacts root and the per-scope directory are `realpath`'d and
 *   required to stay strictly inside the cache root, which rejects a symlinked
 *   directory pointing outside.
 * - The temp file is created with `O_CREAT|O_EXCL` (refuses to follow a planted
 *   symlink) and mode `0600`, fsync'd, then `rename`d over the target. `rename`
 *   replaces a symlink at the destination rather than writing through it.
 *
 * @returns absolute path of the written artifact.
 */
export async function writeDiffArtifact(
  opts: WriteDiffArtifactOpts,
): Promise<string> {
  const root = diffArtifactsRoot(opts.cacheDir);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });

  const realCache = await fs.realpath(opts.cacheDir);
  const realRoot = await fs.realpath(root);
  if (!isStrictlyUnder(realRoot, realCache)) {
    throw new GrokMcpError(
      "GROK_MCP_PATH_TRAVERSAL",
      "diff artifacts root escapes the managed cache root",
      { artifacts_root: realRoot, cache_root: realCache },
    );
  }

  const dirName = artifactScopeHash(opts.scope);
  if (!ARTIFACT_DIR_RE.test(dirName)) {
    throw new GrokMcpError(
      "GROK_MCP_INTERNAL",
      "computed diff artifact directory name is not a scope digest",
    );
  }
  const scopeDir = path.join(realRoot, dirName);
  await fs.mkdir(scopeDir, { recursive: true, mode: 0o700 });
  const realScopeDir = await fs.realpath(scopeDir);
  if (!isStrictlyUnder(realScopeDir, realRoot)) {
    throw new GrokMcpError(
      "GROK_MCP_PATH_TRAVERSAL",
      "diff artifact directory escapes the managed artifacts root",
      { artifact_dir: realScopeDir, artifacts_root: realRoot },
    );
  }

  const fileName = `${opts.artifactId}.diff`;
  if (!ARTIFACT_FILE_RE.test(fileName)) {
    throw new GrokMcpError(
      "GROK_MCP_INVALID_ARGS",
      "diff artifact id must be a UUID",
      { artifact_id: opts.artifactId },
    );
  }
  const target = path.join(realScopeDir, fileName);
  const tmp = path.join(
    realScopeDir,
    `.${opts.artifactId}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );

  // "wx" == O_CREAT|O_EXCL|O_WRONLY: fails on an existing path, including a symlink.
  const fh = await fs.open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(opts.redactedDiff, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return target;
}

/**
 * TTL GC for diff artifacts. Deletes **only** validated managed artifacts:
 * strictly under the realpath'd `<cacheDir>/diffs`, in a directory whose name is
 * a scope digest, a regular file (never a symlink) whose name is a managed
 * artifact or temp name, and older than `ttlHours`.
 *
 * Anything else — unknown paths, files outside the cache root, symlinks and
 * their targets, unmanaged files — is left untouched.
 *
 * @returns number of artifact files removed.
 */
export async function gcDiffArtifacts(
  cacheDir: string,
  ttlHours: number,
): Promise<number> {
  const cutoff = Date.now() - ttlHours * 3600_000;
  let realCache: string;
  let realRoot: string;
  try {
    realCache = await fs.realpath(cacheDir);
    realRoot = await fs.realpath(diffArtifactsRoot(cacheDir));
  } catch {
    return 0; // nothing created yet
  }
  if (!isStrictlyUnder(realRoot, realCache)) {
    logger.warn("Refusing artifact GC: artifacts root outside cache root", {
      artifacts_root: realRoot,
      cache_root: realCache,
    });
    return 0;
  }

  let removed = 0;
  let scopeDirs: Dirent[] = [];
  try {
    scopeDirs = await fs.readdir(realRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const dirent of scopeDirs) {
    // Dirent uses lstat semantics: a symlinked directory is not isDirectory().
    if (!dirent.isDirectory() || !ARTIFACT_DIR_RE.test(dirent.name)) continue;
    const scopeDir = path.join(realRoot, dirent.name);
    let realScopeDir: string;
    try {
      realScopeDir = await fs.realpath(scopeDir);
    } catch {
      continue;
    }
    if (!isStrictlyUnder(realScopeDir, realRoot)) continue;

    let files: Dirent[] = [];
    try {
      files = await fs.readdir(realScopeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile()) continue; // skips symlinks, dirs, sockets
      if (!ARTIFACT_FILE_RE.test(f.name) && !ARTIFACT_TMP_RE.test(f.name)) {
        continue;
      }
      const abs = path.join(realScopeDir, f.name);
      try {
        const st = await fs.lstat(abs);
        if (!st.isFile()) continue;
        if (st.mtimeMs >= cutoff) continue;
        await fs.unlink(abs);
        removed++;
      } catch (err) {
        logger.warn("Failed to GC diff artifact", { path: abs, err: String(err) });
      }
    }
    // Only succeeds when the directory is empty; never recursive.
    await fs.rmdir(realScopeDir).catch(() => undefined);
  }

  return removed;
}
