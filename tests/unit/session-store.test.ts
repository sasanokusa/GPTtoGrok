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
});
