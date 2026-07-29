import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/session-store.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("SessionStore", () => {
  it("atomically upserts and reads sessions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-ss-"));
    tmpDirs.push(dir);
    const store = new SessionStore(path.join(dir, "sessions.json"), 10);
    await store.upsert("s1", {
      mode: "write_worktree",
      repo_root: "/repo",
      original_cwd: "/repo",
      worktree_path: "/wt",
      created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
      tool: "grok_implement",
    });
    const rec = await store.get("s1");
    expect(rec?.worktree_path).toBe("/wt");
    expect(fs.existsSync(path.join(dir, "sessions.json"))).toBe(true);
  });

  it("recovers from corrupt store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-ss-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "sessions.json");
    fs.writeFileSync(file, "{not json");
    const store = new SessionStore(file, 10);
    const rec = await store.get("missing");
    expect(rec).toBeUndefined();
    // backup created
    const backups = fs.readdirSync(dir).filter((f) => f.includes("corrupt"));
    expect(backups.length).toBeGreaterThan(0);
  });

  it("preserves managed session metadata across upsert overwrite", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-ss-"));
    tmpDirs.push(dir);
    const store = new SessionStore(path.join(dir, "sessions.json"), 10);
    const createdAt = "2020-01-01T00:00:00.000Z";
    await store.upsert("s-managed", {
      mode: "write_worktree",
      repo_root: "/repo",
      original_cwd: "/repo",
      worktree_path: "/cache/worktrees/abc/s1",
      worktree_name: "s1",
      managed: true,
      created_at: createdAt,
      last_used_at: createdAt,
      tool: "grok_implement",
    });

    const prior = await store.get("s-managed");
    expect(prior?.managed).toBe(true);
    expect(prior?.worktree_path).toBe("/cache/worktrees/abc/s1");
    expect(prior?.created_at).toBe(createdAt);

    // Simulate resume upsert that preserves managed metadata from prior.
    await store.upsert("s-managed", {
      mode: "write_worktree",
      repo_root: prior!.repo_root,
      original_cwd: prior!.original_cwd,
      worktree_path: prior!.worktree_path,
      worktree_name: prior!.worktree_name,
      managed: prior!.managed ?? false,
      created_at: prior!.created_at,
      last_used_at: new Date().toISOString(),
      tool: "grok_continue",
    });

    const after = await store.get("s-managed");
    expect(after?.managed).toBe(true);
    expect(after?.worktree_path).toBe("/cache/worktrees/abc/s1");
    expect(after?.worktree_name).toBe("s1");
    expect(after?.created_at).toBe(createdAt);
    expect(after?.tool).toBe("grok_continue");
  });
});
