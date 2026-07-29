import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { GrokMcpError } from "./errors.js";
import { getRepoRoot, runGit } from "./git.js";
import { logger } from "./log.js";
import { isPathInside } from "./path-guard.js";

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

export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  try {
    const r = await runGit(
      ["worktree", "remove", "--force", worktreePath],
      repoRoot,
      120_000,
    );
    if (r.exitCode !== 0) {
      // best-effort force remove directory + prune
      await fs.rm(worktreePath, { recursive: true, force: true });
      await runGit(["worktree", "prune"], repoRoot);
    }
  } catch (err) {
    logger.warn("worktree remove failed", { worktreePath, err: String(err) });
    try {
      await fs.rm(worktreePath, { recursive: true, force: true });
      await runGit(["worktree", "prune"], repoRoot);
    } catch {
      /* ignore */
    }
  }
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
