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

  it("protects a fresh heartbeat even when created_at is past hard max", async () => {
    // maxTimeoutMs is not a wall-clock bound on queue+run+tests+cleanup.
    // An actively heartbeating owner must never be collected solely for age.
    const maxTimeoutMs = 1_000;
    const { first, second, leaseDir } = await makeStorePair({ maxTimeoutMs });
    await first.upsert("heartbeat-over-hard-max", staleRecord());
    first.markRunning("heartbeat-over-hard-max");

    try {
      const leases = listLeaseFiles(leaseDir);
      expect(leases.length).toBe(1);
      const leasePath = leases[0]!;
      const hardMax = maxTimeoutMs + LEASE_HARD_GRACE_MS;
      const body = JSON.parse(fsSync.readFileSync(leasePath, "utf8")) as {
        owner: string;
        pid: number;
        created_at: number;
      };
      fsSync.writeFileSync(
        leasePath,
        JSON.stringify({
          ...body,
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
      // Re-plant: stale mtime + live PID + created_at past hard max → collectible.
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

  it("isRunning probe does not unlink a dead lease (no pre-claim gap)", async () => {
    const maxTimeoutMs = 1_000;
    const { first, second, leaseDir } = await makeStorePair({ maxTimeoutMs });
    await first.upsert("probe-no-unlink", staleRecord());
    first.markRunning("probe-no-unlink");
    const leases = listLeaseFiles(leaseDir);
    const leasePath = leases[0]!;
    const hardMax = maxTimeoutMs + LEASE_HARD_GRACE_MS;
    const body = JSON.parse(fsSync.readFileSync(leasePath, "utf8")) as {
      owner: string;
      pid: number;
      created_at: number;
    };
    fsSync.writeFileSync(
      leasePath,
      JSON.stringify({
        ...body,
        created_at: Date.now() - hardMax - 1_000,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    ageLeaseMtime(leasePath, LEASE_SOFT_TTL_MS + 60_000);

    // Probe must report not-running without deleting the file.
    expect(second.isRunning("probe-no-unlink")).toBe(false);
    expect(fsSync.existsSync(leasePath)).toBe(true);

    first.markDone("probe-no-unlink");
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

  it("skips candidates refreshed after snapshot (multi-candidate interleaving)", async () => {
    const { first } = await makeStorePair();
    // Insertion order is iteration order for Object.keys sessions.
    await first.upsert("session-a", staleRecord());
    await first.upsert("session-b", staleRecord());
    await first.upsert("session-c", staleRecord());

    const removedIds: string[] = [];
    const removed = await first.gc(1, async (entry) => {
      const id =
        "session_id" in entry && entry.session_id
          ? entry.session_id
          : "unknown";
      removedIds.push(id);
      // While reclaiming A, refresh B so the post-snapshot pre-claim check
      // (and commit stamp check) must skip B. C stays stale.
      if (id === "session-a") {
        await first.upsert("session-b", {
          ...staleRecord(),
          last_used_at: new Date().toISOString(),
          worktree_path: "/cache/worktree-b-refreshed",
        });
      }
      return true;
    });

    expect(removedIds).toEqual(["session-a", "session-c"]);
    expect(removed).toBe(2);
    expect(await first.get("session-a")).toBeUndefined();
    expect(await first.get("session-c")).toBeUndefined();
    const b = await first.get("session-b");
    expect(b).toBeDefined();
    expect(b?.worktree_path).toBe("/cache/worktree-b-refreshed");
  });

  it("does not commit deletion when the target is refreshed during removal", async () => {
    const { first } = await makeStorePair();
    await first.upsert("refresh-during-rm", staleRecord());
    await first.upsert("other-stale", staleRecord());

    const removed = await first.gc(1, async (entry) => {
      const id =
        "session_id" in entry && entry.session_id
          ? entry.session_id
          : "unknown";
      if (id === "refresh-during-rm") {
        // Touch after claim+removal success would have been recorded — commit
        // stamp check must refuse to drop the refreshed session.
        await first.upsert("refresh-during-rm", {
          ...staleRecord(),
          last_used_at: new Date().toISOString(),
        });
      }
      return true;
    });

    // other-stale deleted; refresh-during-rm kept despite remove callback true.
    expect(removed).toBe(1);
    expect(await first.get("other-stale")).toBeUndefined();
    expect(await first.get("refresh-during-rm")).toBeDefined();
  });

  it("atomically reclaims a stale heartbeat past hard max despite live owner", async () => {
    // Stale mtime + created_at past hard max ⇒ collectible even if the owner
    // process is still alive and tries a heartbeat around claim acquisition.
    // Fresh-heartbeat protection must not apply once mtime is stale.
    vi.useFakeTimers();
    const maxTimeoutMs = 1_000;
    const hardMax = maxTimeoutMs + LEASE_HARD_GRACE_MS;
    const { first, second, leaseDir } = await makeStorePair({ maxTimeoutMs });
    await first.upsert("atomic-hard-max", staleRecord());
    first.markRunning("atomic-hard-max");

    const leasesBefore = listLeaseFiles(leaseDir);
    expect(leasesBefore.length).toBe(1);
    const leasePath = leasesBefore[0]!;
    const original = JSON.parse(fsSync.readFileSync(leasePath, "utf8")) as {
      owner: string;
      pid: number;
      created_at: number;
    };
    // Age disk lease past hard max with stale mtime. Keep markRunning active
    // so a heartbeat tick will attempt utimes/recreate around claim.
    // Use original.created_at for the in-memory clock consistency check after
    // recreate attempts — writeLeaseLocked preserves leaseStartedAt which
    // matches original.created_at from markRunning.
    fsSync.writeFileSync(
      leasePath,
      JSON.stringify({
        owner: original.owner,
        pid: original.pid,
        created_at: original.created_at - hardMax - 5_000,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    // Also age the in-process start clock so a recreate cannot mint a live
    // window under the hard-max bound (leaseStartedAt is private; force by
    // rewriting then relying on claim refusal + preserved started_at).
    // Force leaseStartedAt alignment: rewrite after markRunning used now;
    // for recreate preservation we assert claim refusal, not new liveness.
    ageLeaseMtime(leasePath, LEASE_SOFT_TTL_MS + 60_000);

    // isRunning probe must not create an unlink gap.
    expect(second.isRunning("atomic-hard-max")).toBe(false);
    expect(fsSync.existsSync(leasePath)).toBe(true);

    let sawClaimBeforeRemove = false;
    const removed = await second.gc(1, async () => {
      const claims = fsSync
        .readdirSync(leaseDir)
        .filter((n) => n.endsWith(".gc"));
      expect(claims.length).toBe(1);
      sawClaimBeforeRemove = true;
      // Heartbeat tick around claim/removal: owner still markRunning.
      // utimes may fail (lease purged under claim); recreate must refuse claim.
      await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_MS + 50);
      const claimsAfter = fsSync
        .readdirSync(leaseDir)
        .filter((n) => n.endsWith(".gc"));
      expect(claimsAfter.length).toBe(1);
      // No live foreign lease may have been minted under the claim.
      expect(second.isRunning("atomic-hard-max")).toBe(false);
      return true;
    });

    expect(sawClaimBeforeRemove).toBe(true);
    expect(removed).toBe(1);
    expect(await second.get("atomic-hard-max")).toBeUndefined();
    const leftoverClaims = fsSync
      .readdirSync(leaseDir)
      .filter((n) => n.endsWith(".gc"));
    expect(leftoverClaims).toEqual([]);

    try {
      first.markDone("atomic-hard-max");
    } catch {
      /* ok */
    }
  });

  it("markRunning rejects a foreign active lease for the same id", async () => {
    const { first, second, leaseDir } = await makeStorePair();
    first.markRunning("single-resumer");
    try {
      expect(() => second.markRunning("single-resumer")).toThrowError(
        /active lease from another/i,
      );
      // Foreign instance must not have written its own lease.
      const leases = listLeaseFiles(leaseDir);
      expect(leases.length).toBe(1);
    } finally {
      first.markDone("single-resumer");
    }

    // After release, second can acquire.
    second.markRunning("single-resumer");
    second.markDone("single-resumer");
  });

  it("heartbeat recreation preserves original created_at (hard-max clock)", async () => {
    vi.useFakeTimers();
    const { first, leaseDir } = await makeStorePair({ maxTimeoutMs: 3_600_000 });
    first.markRunning("preserve-start");
    try {
      const before = listLeaseFiles(leaseDir);
      expect(before.length).toBe(1);
      const original = JSON.parse(fsSync.readFileSync(before[0]!, "utf8")) as {
        created_at: number;
      };
      // Force recreate path (lease file gone) while markRunning is still held.
      fsSync.unlinkSync(before[0]!);
      await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_MS + 50);
      const after = listLeaseFiles(leaseDir);
      expect(after.length).toBe(1);
      const recreated = JSON.parse(fsSync.readFileSync(after[0]!, "utf8")) as {
        created_at: number;
      };
      expect(recreated.created_at).toBe(original.created_at);
    } finally {
      first.markDone("preserve-start");
    }
  });
});
