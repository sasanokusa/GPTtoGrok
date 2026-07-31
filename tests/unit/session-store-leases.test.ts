import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GC_CLAIM_RENEW_MS,
  GC_CLAIM_TTL_MS,
  isProcessAlive,
  LEASE_HARD_GRACE_MS,
  LEASE_HEARTBEAT_MS,
  LEASE_SOFT_TTL_MS,
  SessionStore,
} from "../../src/session-store.js";
import type { SessionRecord } from "../../src/types.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeStorePair(options?: {
  maxTimeoutMs?: number;
}): Promise<{
  first: SessionStore;
  second: SessionStore;
  file: string;
  leaseDir: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgm-session-lease-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "sessions.json");
  const opts = { maxTimeoutMs: options?.maxTimeoutMs ?? 3_600_000 };
  return {
    first: new SessionStore(file, 500, opts),
    second: new SessionStore(file, 500, opts),
    file,
    leaseDir: `${file}.leases`,
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

function listLeaseFiles(leaseDir: string): string[] {
  try {
    return fsSync
      .readdirSync(leaseDir)
      .filter((n) => n.endsWith(".lease"))
      .map((n) => path.join(leaseDir, n));
  } catch {
    return [];
  }
}

function ageLeaseMtime(leasePath: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  fsSync.utimesSync(leasePath, when, when);
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

  it("keeps a suspended live process protected past soft TTL via PID liveness", async () => {
    const { first, second, leaseDir } = await makeStorePair({
      maxTimeoutMs: 3_600_000,
    });
    await first.upsert("suspended-session", staleRecord());
    first.markRunning("suspended-session");

    try {
      const leases = listLeaseFiles(leaseDir);
      expect(leases.length).toBe(1);
      // Simulate laptop sleep / debugger pause: heartbeat mtime goes stale but
      // the owning process (this test process) is still alive and under hard max.
      ageLeaseMtime(leases[0]!, LEASE_SOFT_TTL_MS + 60_000);

      let calls = 0;
      const removed = await second.gc(1, async () => {
        calls++;
        return true;
      });
      expect(removed).toBe(0);
      expect(calls).toBe(0);
      expect(await second.get("suspended-session")).toBeDefined();
    } finally {
      first.markDone("suspended-session");
    }
  });

  it("allows GC when the owner PID is dead and soft TTL has elapsed", async () => {
    const { second, file, leaseDir } = await makeStorePair({
      maxTimeoutMs: 60_000,
    });
    await second.upsert("dead-pid-session", staleRecord());

    // Plant a foreign lease for a definitely-dead PID, past soft TTL.
    fsSync.mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    const key = crypto.createHash("sha256").update("dead-pid-session").digest("hex");
    const leasePath = path.join(leaseDir, `${key}.dead-owner.lease`);
    const deadPid = 2_147_483_646; // unlikely to be live; confirm
    expect(isProcessAlive(deadPid)).toBe(false);
    fsSync.writeFileSync(
      leasePath,
      JSON.stringify({
        owner: "dead-owner",
        pid: deadPid,
        created_at: Date.now() - 30_000,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    ageLeaseMtime(leasePath, LEASE_SOFT_TTL_MS + 60_000);
    void file;

    const removed = await second.gc(1, async () => true);
    expect(removed).toBe(1);
    expect(await second.get("dead-pid-session")).toBeUndefined();
  });

  it("does not GC a still-heartbeating lease even past hard max age", async () => {
    // Fresh heartbeat is authoritative: an active run must never be collected
    // mid-flight solely because created_at is old.
    const maxTimeoutMs = 1_000;
    const { first, second, leaseDir } = await makeStorePair({ maxTimeoutMs });
    await first.upsert("heartbeat-over-hard-max", staleRecord());
    first.markRunning("heartbeat-over-hard-max");

    try {
      const leases = listLeaseFiles(leaseDir);
      expect(leases.length).toBe(1);
      const leasePath = leases[0]!;
      const hardMax = maxTimeoutMs + LEASE_HARD_GRACE_MS;
      fsSync.writeFileSync(
        leasePath,
        JSON.stringify({
          owner: "test-owner",
          pid: process.pid,
          created_at: Date.now() - hardMax - 1_000,
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      const now = new Date();
      fsSync.utimesSync(leasePath, now, now);

      let calls = 0;
      const removed = await second.gc(1, async () => {
        calls++;
        return true;
      });
      expect(removed).toBe(0);
      expect(calls).toBe(0);
      expect(await second.get("heartbeat-over-hard-max")).toBeDefined();
    } finally {
      first.markDone("heartbeat-over-hard-max");
    }
  });

  it("allows GC past hard max when heartbeat is stale even if PID is alive", async () => {
    const maxTimeoutMs = 1_000;
    const { first, second, leaseDir } = await makeStorePair({ maxTimeoutMs });
    await first.upsert("overlong-session", staleRecord());
    first.markRunning("overlong-session");

    try {
      const leases = listLeaseFiles(leaseDir);
      expect(leases.length).toBe(1);
      const leasePath = leases[0]!;
      const hardMax = maxTimeoutMs + LEASE_HARD_GRACE_MS;
      // Clear in-process running state so second.gc consults the lease file.
      first.markDone("overlong-session");
      // Re-plant: stale mtime + live PID + created_at past hard max → collectible
      // (PID-liveness extension is bounded by hard max).
      fsSync.writeFileSync(
        leasePath,
        JSON.stringify({
          owner: "test-owner",
          pid: process.pid,
          created_at: Date.now() - hardMax - 1_000,
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      ageLeaseMtime(leasePath, LEASE_SOFT_TTL_MS + 60_000);

      const removed = await second.gc(1, async () => true);
      expect(removed).toBe(1);
      expect(await second.get("overlong-session")).toBeUndefined();
    } finally {
      try {
        first.markDone("overlong-session");
      } catch {
        /* already done */
      }
    }
  });

  it("does not commit store deletion when the GC claim is lost mid-removal", async () => {
    const { first, leaseDir } = await makeStorePair();
    await first.upsert("claim-lost-session", staleRecord());

    const removed = await first.gc(1, async () => {
      const claims = fsSync
        .readdirSync(leaseDir)
        .filter((n) => n.endsWith(".gc"));
      expect(claims.length).toBe(1);
      // Simulate exclusivity loss (expired/stolen claim) before commit.
      fsSync.unlinkSync(path.join(leaseDir, claims[0]!));
      return true;
    });

    expect(removed).toBe(0);
    expect(await first.get("claim-lost-session")).toBeDefined();
  });

  it("recreates a lost lease on heartbeat so an active run stays protected", async () => {
    vi.useFakeTimers();
    const { first, second, leaseDir } = await makeStorePair();
    await first.upsert("heartbeat-session", staleRecord());
    first.markRunning("heartbeat-session");

    try {
      const before = listLeaseFiles(leaseDir);
      expect(before.length).toBe(1);
      fsSync.unlinkSync(before[0]!);
      expect(listLeaseFiles(leaseDir)).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_MS + 50);

      const after = listLeaseFiles(leaseDir);
      expect(after.length).toBe(1);

      let calls = 0;
      const removed = await second.gc(1, async () => {
        calls++;
        return true;
      });
      expect(removed).toBe(0);
      expect(calls).toBe(0);
    } finally {
      first.markDone("heartbeat-session");
    }
  });

  it("renews GC claims during long worktree removal", async () => {
    vi.useFakeTimers();
    const { first, leaseDir } = await makeStorePair();
    await first.upsert("slow-gc-session", staleRecord());

    let sawRenewal = false;

    const removed = await first.gc(1, async () => {
      const claims = fsSync
        .readdirSync(leaseDir)
        .filter((n) => n.endsWith(".gc"));
      expect(claims.length).toBe(1);
      const claimPath = path.join(leaseDir, claims[0]!);
      const before = JSON.parse(fsSync.readFileSync(claimPath, "utf8")) as {
        expires_at: number;
      };
      // Advance one renew interval; expires_at should move forward by ~RENEW_MS
      // (new expires = now+TTL, old was roughly now_old+TTL).
      await vi.advanceTimersByTimeAsync(GC_CLAIM_RENEW_MS + 100);
      const after = JSON.parse(fsSync.readFileSync(claimPath, "utf8")) as {
        expires_at: number;
      };
      expect(after.expires_at).toBeGreaterThan(before.expires_at);
      expect(after.expires_at - before.expires_at).toBeGreaterThanOrEqual(
        GC_CLAIM_RENEW_MS - 1_000,
      );
      // Renewed claim still has a full TTL of life from "now".
      expect(after.expires_at).toBeGreaterThan(Date.now() + GC_CLAIM_TTL_MS - 5_000);
      sawRenewal = true;
      return true;
    });

    expect(removed).toBe(1);
    expect(sawRenewal).toBe(true);
  });
});
