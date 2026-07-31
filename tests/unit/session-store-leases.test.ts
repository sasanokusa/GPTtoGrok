import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/session-store.js";
import type { SessionRecord } from "../../src/types.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeStorePair(): Promise<{
  first: SessionStore;
  second: SessionStore;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgm-session-lease-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "sessions.json");
  return {
    first: new SessionStore(file),
    second: new SessionStore(file),
  };
}

function staleRecord(): SessionRecord {
  return {
    mode: "write_worktree",
    repo_root: "/repo",
    original_cwd: "/repo",
    worktree_path: "/cache/worktree",
    managed: true,
    created_at: "2000-01-01T00:00:00.000Z",
    last_used_at: "2000-01-01T00:00:00.000Z",
    tool: "grok_implement",
  };
}

describe("SessionStore cross-process leases", () => {
  it("prevents another store instance from collecting an active session", async () => {
    const { first, second } = await makeStorePair();
    await first.upsert("active-session", staleRecord());
    first.markRunning("active-session");

    try {
      let calls = 0;
      const removed = await second.gc(1, async () => {
        calls++;
        return true;
      });

      expect(removed).toBe(0);
      expect(calls).toBe(0);
      expect(await second.get("active-session")).toBeDefined();
    } finally {
      first.markDone("active-session");
    }

    const removedAfterRelease = await second.gc(1, async () => true);
    expect(removedAfterRelease).toBe(1);
    expect(await second.get("active-session")).toBeUndefined();
  });

  it("keeps the record when worktree removal returns false", async () => {
    const { first } = await makeStorePair();
    await first.upsert("retry-session", staleRecord());

    const removed = await first.gc(1, async () => false);

    expect(removed).toBe(0);
    expect(await first.get("retry-session")).toBeDefined();
  });

  it("blocks a resume while a GC claim owns the session", async () => {
    const { first, second } = await makeStorePair();
    await first.upsert("claimed-session", staleRecord());

    const removed = await second.gc(1, async () => {
      expect(() => first.markRunning("claimed-session")).toThrowError(
        /being reaped/i,
      );
      return false;
    });

    expect(removed).toBe(0);
    expect(await first.get("claimed-session")).toBeDefined();
  });
});
