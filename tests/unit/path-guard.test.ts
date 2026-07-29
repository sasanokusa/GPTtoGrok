import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrokMcpError } from "../../src/errors.js";
import {
  isPathInside,
  resolveWorkingDirectory,
  shouldDenyRepoRootWrites,
} from "../../src/path-guard.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkTmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "cgm-path-"));
  tmpDirs.push(d);
  return d;
}

describe("path-guard", () => {
  it("rejects relative working_directory", async () => {
    await expect(
      resolveWorkingDirectory("relative/path", [os.homedir()]),
    ).rejects.toMatchObject({ code: "GROK_MCP_INVALID_ARGS" });
  });

  it("rejects paths outside allowed roots", async () => {
    const d = await mkTmp();
    await expect(
      resolveWorkingDirectory(d, [path.join(os.homedir(), "only-this")]),
    ).rejects.toMatchObject({ code: "GROK_MCP_PATH_NOT_ALLOWED" });
  });

  it("accepts absolute path inside allowed root", async () => {
    const d = await mkTmp();
    const r = await resolveWorkingDirectory(d, [os.tmpdir()]);
    expect(r.realpath).toBe(await fs.realpath(d));
  });

  it("rejects null bytes", async () => {
    await expect(
      resolveWorkingDirectory("/tmp/\0evil", [os.tmpdir()]),
    ).rejects.toBeInstanceOf(GrokMcpError);
  });

  it("isPathInside works for nested paths", () => {
    expect(isPathInside("/a/b/c", "/a/b")).toBe(true);
    expect(isPathInside("/a/b", "/a/b")).toBe(true);
    expect(isPathInside("/a/bc", "/a/b")).toBe(false);
  });

  it("shouldDenyRepoRootWrites only when worktree outside repo", () => {
    expect(shouldDenyRepoRootWrites("/repo", "/cache/wt")).toBe(true);
    expect(shouldDenyRepoRootWrites("/repo", "/repo/.worktrees/x")).toBe(false);
  });
});
