import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GrokMcpError } from "./errors.js";

const IS_DARWIN = process.platform === "darwin";

export function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

export function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  return IS_DARWIN ? resolved.toLowerCase() : resolved;
}

/** True if `child` is equal to or inside `parent` (after realpath-style normalize). */
export function isPathInside(child: string, parent: string): boolean {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  if (c === p) return true;
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(prefix);
}

export function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) || p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

export interface ResolvedPath {
  input: string;
  absolute: string;
  realpath: string;
}

/**
 * Validate and resolve working_directory.
 * v1 requires absolute paths (relative rejected).
 */
export async function resolveWorkingDirectory(
  input: string,
  allowedRoots: string[],
): Promise<ResolvedPath> {
  if (!input || typeof input !== "string") {
    throw new GrokMcpError("GROK_MCP_INVALID_ARGS", "working_directory is required");
  }
  if (input.includes("\0")) {
    throw new GrokMcpError("GROK_MCP_PATH_TRAVERSAL", "Path contains null bytes");
  }

  const expanded = expandHome(input.trim());
  if (!isAbsolutePath(expanded)) {
    throw new GrokMcpError(
      "GROK_MCP_INVALID_ARGS",
      "working_directory must be an absolute path (relative paths are rejected)",
    );
  }

  const absolute = path.resolve(expanded);

  let realpath: string;
  try {
    realpath = await fs.realpath(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new GrokMcpError(
        "GROK_MCP_NOT_A_DIRECTORY",
        `working_directory does not exist: ${absolute}`,
      );
    }
    throw new GrokMcpError(
      "GROK_MCP_PATH_TRAVERSAL",
      `Failed to resolve working_directory: ${absolute}`,
      { cause: String(err) },
    );
  }

  let stat;
  try {
    stat = await fs.stat(realpath);
  } catch {
    throw new GrokMcpError(
      "GROK_MCP_NOT_A_DIRECTORY",
      `working_directory is not accessible: ${realpath}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new GrokMcpError(
      "GROK_MCP_NOT_A_DIRECTORY",
      `working_directory is not a directory: ${realpath}`,
    );
  }

  // Realpath roots so macOS /var vs /private/var (and other symlinks) match.
  const roots: string[] = [];
  for (const r of allowedRoots) {
    const resolved = path.resolve(expandHome(r));
    try {
      roots.push(await fs.realpath(resolved));
    } catch {
      roots.push(resolved);
    }
  }
  const allowed = roots.some((root) => isPathInside(realpath, root));
  if (!allowed) {
    throw new GrokMcpError(
      "GROK_MCP_PATH_NOT_ALLOWED",
      `working_directory is outside allowed roots: ${realpath}`,
      { allowed_roots: roots },
    );
  }

  return { input, absolute, realpath };
}

export function shouldDenyRepoRootWrites(
  repoRoot: string,
  worktreePath: string,
): boolean {
  return !isPathInside(worktreePath, repoRoot);
}
