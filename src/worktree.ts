import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { GrokMcpError } from "./errors.js";
import { getRepoRoot, runGit } from "./git.js";
import { logger } from "./log.js";
import {
  isAbsolutePath,
  isPathInside,
  normalizeForCompare,
} from "./path-guard.js";

export interface CreateWorktreeOpts {
  repoRoot: string;
  worktreesRoot: string;
  name?: string;
  ref?: string;
  tool: string;
}

export interface CreatedWorktree {
  worktreeName: string;
  worktreePath: string;
  branch: string;
  managed: true;
}

function repoHash(repoRoot: string): string {
  return crypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
}

function randomHex(n = 8): string {
  return crypto.randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
}

/** True if `child` is strictly inside `parent` (not equal). */
export function isStrictlyUnder(child: string, parent: string): boolean {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  if (c === p) return false;
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(prefix);
}

/**
 * Resolve a worktree path: must be absolute, must exist, returns realpath.
 */
export async function resolveWorktreeRealpath(input: string): Promise<string> {
  if (!input || typeof input !== "string") {
    throw new GrokMcpError(
      "GROK_MCP_WORKTREE_INVALID",
      "worktree_path is required",
    );
  }
  if (input.includes("\0")) {
    throw new GrokMcpError(
      "GROK_MCP_PATH_TRAVERSAL",
      "worktree_path contains null bytes",
    );
  }
  const trimmed = input.trim();
  if (!isAbsolutePath(trimmed)) {
    throw new GrokMcpError(
      "GROK_MCP_INVALID_ARGS",
      "worktree_path must be an absolute path (relative paths are rejected)",
    );
  }
  const absolute = path.resolve(trimmed);
  try {
    const real = await fs.realpath(absolute);
    const st = await fs.stat(real);
    if (!st.isDirectory()) {
      throw new GrokMcpError(
        "GROK_MCP_WORKTREE_INVALID",
        `worktree_path is not a directory: ${real}`,
      );
    }
    return real;
  } catch (err) {
    if (err instanceof GrokMcpError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new GrokMcpError(
        "GROK_MCP_WORKTREE_MISSING",
        `worktree_path does not exist: ${absolute}`,
      );
    }
    throw new GrokMcpError(
      "GROK_MCP_WORKTREE_INVALID",
      `Failed to resolve worktree_path: ${absolute}`,
      { cause: String(err) },
    );
  }
}

/** Paths registered via `git worktree list --porcelain` for the given repo. */
export async function listRegisteredWorktreePaths(
  repoRoot: string,
): Promise<string[]> {
  const r = await runGit(["worktree", "list", "--porcelain"], repoRoot);
  if (r.exitCode !== 0) {
    return [];
  }
  const paths: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const p = line.slice("worktree ".length).trim();
    if (!p) continue;
    try {
      paths.push(await fs.realpath(p));
    } catch {
      paths.push(path.resolve(p));
    }
  }
  return paths;
}

export async function isRegisteredWorktree(
  repoRoot: string,
  worktreeRealpath: string,
): Promise<boolean> {
  const registered = await listRegisteredWorktreePaths(repoRoot);
  const target = normalizeForCompare(worktreeRealpath);
  return registered.some((p) => normalizeForCompare(p) === target);
}

export interface AssertManagedWorktreeOpts {
  worktreePath: string;
  repoRoot: string;
  worktreesRoot: string;
  /** When false, skip existence/realpath of path (caller already resolved). Default true. */
  alreadyResolved?: boolean;
}

/**
 * Assert worktree is a server-managed path: absolute realpath, strictly under
 * worktreesRoot, not the original repo root, and registered to that repo via
 * `git worktree list`.
 * Returns the resolved realpath.
 */
export async function assertServerManagedWorktree(
  opts: AssertManagedWorktreeOpts,
): Promise<string> {
  const realWt = opts.alreadyResolved
    ? opts.worktreePath
    : await resolveWorktreeRealpath(opts.worktreePath);

  let realRoot: string;
  try {
    realRoot = await fs.realpath(opts.repoRoot);
  } catch {
    realRoot = path.resolve(opts.repoRoot);
  }

  let realWorktreesRoot: string;
  try {
    await fs.mkdir(opts.worktreesRoot, { recursive: true });
    realWorktreesRoot = await fs.realpath(opts.worktreesRoot);
  } catch {
    realWorktreesRoot = path.resolve(opts.worktreesRoot);
  }

  if (normalizeForCompare(realWt) === normalizeForCompare(realRoot)) {
    throw new GrokMcpError(
      "GROK_MCP_WORKTREE_INVALID",
      "worktree_path must not be the original repository root",
      { worktree_path: realWt, repo_root: realRoot },
    );
  }

  if (!isStrictlyUnder(realWt, realWorktreesRoot)) {
    throw new GrokMcpError(
      "GROK_MCP_WORKTREE_INVALID",
      "worktree_path is not under the server-managed worktrees root",
      {
        worktree_path: realWt,
        worktrees_root: realWorktreesRoot,
      },
    );
  }

  const registered = await isRegisteredWorktree(realRoot, realWt);
  if (!registered) {
    throw new GrokMcpError(
      "GROK_MCP_WORKTREE_INVALID",
      "worktree_path is not registered via git worktree list for this repository",
      { worktree_path: realWt, repo_root: realRoot },
    );
  }

  return realWt;
}

/**
 * Non-throwing safety check used by GC / removal. Returns false for any
 * untrusted, unregistered, or outside-root path (never removes those).
 */
export async function isSafeManagedWorktreeForRemoval(
  worktreePath: string | undefined,
  repoRoot: string | undefined,
  worktreesRoot: string,
): Promise<{ safe: true; realPath: string; realRepo: string } | { safe: false }> {
  if (!worktreePath || !repoRoot) return { safe: false };
  try {
    if (!isAbsolutePath(worktreePath) || !isAbsolutePath(repoRoot)) {
      return { safe: false };
    }
    let realWt: string;
    try {
      realWt = await fs.realpath(worktreePath);
    } catch {
      return { safe: false };
    }
    let realRepo: string;
    try {
      realRepo = await fs.realpath(repoRoot);
    } catch {
      realRepo = path.resolve(repoRoot);
    }
    let realWorktreesRoot: string;
    try {
      realWorktreesRoot = await fs.realpath(path.resolve(worktreesRoot));
    } catch {
      // If worktrees root does not exist, nothing under it is safe to rm.
      return { safe: false };
    }
    if (normalizeForCompare(realWt) === normalizeForCompare(realRepo)) {
      return { safe: false };
    }
    if (!isStrictlyUnder(realWt, realWorktreesRoot)) {
      return { safe: false };
    }
    if (!(await isRegisteredWorktree(realRepo, realWt))) {
      return { safe: false };
    }
    return { safe: true, realPath: realWt, realRepo };
  } catch {
    return { safe: false };
  }
}

export async function allocateWorktreeName(
  preferred: string | undefined,
  tool: string,
): Promise<string> {
  if (preferred) {
    if (!/^[A-Za-z0-9._-]+$/.test(preferred) || preferred.length > 64) {
      throw new GrokMcpError(
        "GROK_MCP_INVALID_ARGS",
        "worktree_name must match [A-Za-z0-9._-]{1,64}",
      );
    }
    return preferred;
  }
  return `codex-grok-${tool.replace(/^grok_/, "")}-${randomHex(8)}`;
}

export async function createManagedWorktree(
  opts: CreateWorktreeOpts,
): Promise<CreatedWorktree> {
  const repoRoot = await getRepoRoot(opts.repoRoot);
  let name = await allocateWorktreeName(opts.name, opts.tool);
  const baseDir = path.join(opts.worktreesRoot, repoHash(repoRoot));
  await fs.mkdir(baseDir, { recursive: true });

  let attempts = 0;
  while (attempts < 4) {
    const worktreePath = path.join(baseDir, name);
    const branch = `codex-grok/${name}`;

    // Collision check
    try {
      await fs.access(worktreePath);
      if (opts.name) {
        throw new GrokMcpError(
          "GROK_MCP_WORKTREE_EXISTS",
          `Worktree path already exists: ${worktreePath}`,
        );
      }
      name = await allocateWorktreeName(undefined, opts.tool);
      attempts++;
      continue;
    } catch (err) {
      if (err instanceof GrokMcpError) throw err;
      // ENOENT ok
    }

    const ref = opts.ref || "HEAD";
    const result = await runGit(
      ["worktree", "add", "-b", branch, worktreePath, ref],
      repoRoot,
    );
    if (result.exitCode !== 0) {
      const msg = result.stderr || result.stdout;
      if (/already exists|already checked out/i.test(msg) && !opts.name) {
        name = await allocateWorktreeName(undefined, opts.tool);
        attempts++;
        continue;
      }
      if (/already exists|already checked out/i.test(msg)) {
        throw new GrokMcpError(
          "GROK_MCP_WORKTREE_EXISTS",
          `Worktree or branch already exists: ${name}`,
          { stderr_tail: msg.slice(-800) },
        );
      }
      throw new GrokMcpError(
        "GROK_MCP_WORKTREE_CREATE_FAILED",
        `Failed to create git worktree: ${msg.slice(0, 400)}`,
        { stderr_tail: msg.slice(-800) },
      );
    }

    const real = await fs.realpath(worktreePath);
    logger.info("Created managed worktree", {
      worktree_name: name,
      worktree_path: real,
      repo_root: repoRoot,
    });
    return {
      worktreeName: name,
      worktreePath: real,
      branch,
      managed: true,
    };
  }

  throw new GrokMcpError(
    "GROK_MCP_WORKTREE_CREATE_FAILED",
    "Failed to allocate unique worktree name after retries",
  );
}

/**
 * Best-effort delete of the branch created by `createManagedWorktree`
 * (`codex-grok/<worktreeName>`). Failures are logged only — never fail removal.
 */
async function deleteManagedWorktreeBranch(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  const worktreeName = path.basename(worktreePath);
  if (!worktreeName) return;
  const branch = `codex-grok/${worktreeName}`;
  try {
    const r = await runGit(["branch", "-D", branch], repoRoot);
    if (r.exitCode !== 0) {
      logger.warn("Failed to delete managed worktree branch", {
        branch,
        stderr: r.stderr.slice(-400),
      });
    }
  } catch (err) {
    logger.warn("Failed to delete managed worktree branch", {
      branch,
      err: String(err),
    });
  }
}

/**
 * Remove a managed worktree only if it is strictly under worktreesRoot and
 * registered to the repo. Never recursively removes caller-controlled or
 * unregistered paths (even if sessions.json is malicious).
 * After a successful removal, best-effort deletes `codex-grok/<basename>`.
 *
 * @returns `true` only when the worktree directory is actually gone afterwards;
 *          `false` for unsafe/unregistered paths or if every removal strategy failed.
 */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  worktreesRoot: string,
): Promise<boolean> {
  const check = await isSafeManagedWorktreeForRemoval(
    worktreePath,
    repoRoot,
    worktreesRoot,
  );
  if (!check.safe) {
    logger.warn("Refusing to remove untrusted/unregistered worktree path", {
      worktreePath,
      repoRoot,
    });
    return false;
  }

  try {
    const r = await runGit(
      ["worktree", "remove", "--force", check.realPath],
      check.realRepo,
      120_000,
    );
    if (r.exitCode !== 0) {
      // Re-check immediately before recursive rm (TOCTOU defense)
      const again = await isSafeManagedWorktreeForRemoval(
        check.realPath,
        check.realRepo,
        worktreesRoot,
      );
      if (!again.safe) return false;
      await fs.rm(again.realPath, { recursive: true, force: true });
      await runGit(["worktree", "prune"], again.realRepo);
    }
  } catch (err) {
    logger.warn("worktree remove failed", {
      worktreePath: check.realPath,
      err: String(err),
    });
    try {
      // Re-check immediately before recursive rm (TOCTOU defense)
      const again = await isSafeManagedWorktreeForRemoval(
        check.realPath,
        check.realRepo,
        worktreesRoot,
      );
      if (!again.safe) return false;
      await fs.rm(again.realPath, { recursive: true, force: true });
      await runGit(["worktree", "prune"], again.realRepo);
    } catch {
      /* fall through to existence check */
    }
  }

  // Trust the filesystem, not exit codes alone.
  let stillThere = false;
  try {
    await fs.access(check.realPath);
    stillThere = true;
  } catch {
    stillThere = false;
  }

  if (stillThere) {
    logger.warn("Managed worktree still present after removal attempts", {
      worktreePath: check.realPath,
    });
    return false;
  }

  await deleteManagedWorktreeBranch(check.realRepo, check.realPath);
  return true;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export { isPathInside };
