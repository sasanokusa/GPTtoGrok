import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { GrokMcpError } from "./errors.js";
import type { PendingWorktree, SessionRecord, SessionStoreData } from "./types.js";
import { logger } from "./log.js";

const emptyStore = (): SessionStoreData => ({
  version: 1,
  pending_worktrees: [],
  sessions: {},
});

const LOCK_STALE_MS = 10_000;
const LOCK_HEARTBEAT_MS = 2_000;

// Cross-process leases protect active sessions/runs from another MCP process's
// startup GC. Lease files are deliberately separate from sessions.json so a
// heartbeat never rewrites the whole store.
//
// Liveness (see leaseIsLive) — maxTimeoutMs is NOT a wall-clock bound on the
// full run (queue wait + Grok timeout + test timeout + cleanup), so:
// 1. Fresh heartbeat mtime ⇒ live regardless of created_at. Never GC an
//    actively heartbeating owner solely because created_at is old.
// 2. Stale heartbeat + live owner PID + age ≤ hard max ⇒ live (suspend /
//    debugger pause). Hard max bounds this PID-liveness extension only
//    (PID reuse / silent stuck owner); recreation must not reset created_at.
// 3. Stale heartbeat + (dead PID | past hard max | unparseable) ⇒ collectible.
//
// Dead-lease unlinks happen only under the coordination lock together with GC
// claim acquisition (never during a pure isRunning probe), so a concurrent
// heartbeat cannot observe a gap and mint a fresh hard-max window.
/** Soft lease freshness window based on mtime/heartbeat. Exported for tests. */
export const LEASE_SOFT_TTL_MS = 5 * 60_000;
/** @deprecated Use LEASE_SOFT_TTL_MS. Kept for older test imports. */
export const LEASE_TTL_MS = LEASE_SOFT_TTL_MS;
export const LEASE_HEARTBEAT_MS = 10_000;
/** Extra grace beyond max tool duration before a lease is reaped by hard max. */
export const LEASE_HARD_GRACE_MS = 5 * 60_000;
/** Default hard max when caller does not pass maxTimeoutMs (matches config). */
export const DEFAULT_LEASE_HARD_MAX_MS = 3_600_000 + LEASE_HARD_GRACE_MS;
export const GC_CLAIM_TTL_MS = 15 * 60_000;
export const GC_CLAIM_RENEW_MS = 60_000;
const COORD_LOCK_STALE_MS = 30_000;
const COORD_LOCK_WAIT_MS = 2_000;
const SYNC_WAIT = new Int32Array(new SharedArrayBuffer(4));

interface LeaseRecord {
  owner: string;
  pid: number;
  /** Original lease start; never advanced by heartbeat recreation. */
  created_at: number;
}

interface GcClaim {
  owner: string;
  expires_at: number;
}

export interface SessionStoreOptions {
  /**
   * Configured max tool duration (ms). Bounds only the *stale-heartbeat*
   * PID-liveness extension: `maxTimeoutMs + LEASE_HARD_GRACE_MS` from the
   * original lease `created_at`. Fresh heartbeats remain live past this age
   * because total active wall time can exceed maxTimeoutMs (queue + run +
   * tests + cleanup). Crashed owners (dead PID + stale mtime) stay collectible.
   */
  maxTimeoutMs?: number;
}

/** True when `pid` is a live process we can observe (best-effort, Unix). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM: process exists but we cannot signal it — treat as alive.
    if (code === "EPERM") return true;
    return false;
  }
}

export class SessionStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly leaseDir: string;
  private readonly ownerId: string;
  private readonly maxSessions: number;
  /** Hard ceiling for lease age from original created_at. */
  private readonly leaseHardMaxMs: number;
  private readonly runningCounts = new Map<string, number>();
  private readonly leaseHeartbeats = new Map<string, NodeJS.Timeout>();
  /**
   * Original lease start per id for this process. Heartbeat recreation must
   * reuse this so hard-max reclamation cannot be defeated by a new created_at.
   */
  private readonly leaseStartedAt = new Map<string, number>();

  constructor(
    filePath: string,
    maxSessions = 500,
    options: SessionStoreOptions = {},
  ) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.leaseDir = `${filePath}.leases`;
    this.ownerId = `${process.pid}-${crypto.randomUUID()}`;
    this.maxSessions = maxSessions;
    const maxTimeoutMs = options.maxTimeoutMs ?? 3_600_000;
    this.leaseHardMaxMs = Math.max(
      LEASE_SOFT_TTL_MS,
      maxTimeoutMs + LEASE_HARD_GRACE_MS,
    );
  }

  markRunning(sessionOrRunId: string): void {
    const count = this.runningCounts.get(sessionOrRunId) ?? 0;
    if (count > 0) {
      this.runningCounts.set(sessionOrRunId, count + 1);
      return;
    }

    this.withCoordinationLockSync(sessionOrRunId, () => {
      const claim = this.readActiveClaimLocked(sessionOrRunId);
      if (claim) {
        throw new GrokMcpError(
          "GROK_MCP_BUSY",
          "Session or run is being reaped by another MCP process",
          { session_id: sessionOrRunId },
        );
      }
      // Single-resumer: refuse if another owner still holds a live lease.
      // Dead/expired foreign leases are purged here so we can take over after
      // a crash without leaving the id permanently stuck.
      if (this.hasForeignActiveLeaseLocked(sessionOrRunId)) {
        throw new GrokMcpError(
          "GROK_MCP_BUSY",
          "Session or run already has an active lease from another MCP process",
          { session_id: sessionOrRunId },
        );
      }
      this.purgeDeadLeasesLocked(sessionOrRunId);
      if (!this.leaseStartedAt.has(sessionOrRunId)) {
        this.leaseStartedAt.set(sessionOrRunId, Date.now());
      }
      this.writeLeaseLocked(sessionOrRunId);
    });

    this.runningCounts.set(sessionOrRunId, 1);
    const heartbeat = setInterval(() => {
      this.renewLeaseHeartbeat(sessionOrRunId);
    }, LEASE_HEARTBEAT_MS);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    this.leaseHeartbeats.set(sessionOrRunId, heartbeat);
  }

  markDone(sessionOrRunId: string): void {
    const count = this.runningCounts.get(sessionOrRunId) ?? 0;
    if (count > 1) {
      this.runningCounts.set(sessionOrRunId, count - 1);
      return;
    }
    this.runningCounts.delete(sessionOrRunId);
    this.leaseStartedAt.delete(sessionOrRunId);
    const heartbeat = this.leaseHeartbeats.get(sessionOrRunId);
    if (heartbeat) clearInterval(heartbeat);
    this.leaseHeartbeats.delete(sessionOrRunId);

    try {
      this.withCoordinationLockSync(sessionOrRunId, () => {
        try {
          fs.unlinkSync(this.leasePath(sessionOrRunId));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      });
    } catch (err) {
      // A leaked lease expires by hard-max / dead-PID check; cleanup must not
      // mask the tool result.
      logger.warn("Failed to release session lease", {
        id: sessionOrRunId,
        err: String(err),
      });
    }
  }

  isRunning(id: string): boolean {
    if ((this.runningCounts.get(id) ?? 0) > 0) return true;
    try {
      // Probe only — never unlink dead leases here. Unlink+claim must be atomic
      // under claimForGc so a concurrent heartbeat cannot fill the gap.
      return this.withCoordinationLockSync(id, () =>
        this.hasActiveLeaseLocked(id, { purgeDead: false }),
      );
    } catch (err) {
      // Fail closed: coordination failure must not allow GC/pruning.
      logger.warn("Failed to inspect session lease; treating as running", {
        id,
        err: String(err),
      });
      return true;
    }
  }

  /**
   * Refresh lease mtime; on failure recreate while preserving the original
   * lease start (hard-max clock). Never recreate under a foreign GC claim or
   * a foreign live lease.
   */
  private renewLeaseHeartbeat(sessionOrRunId: string): void {
    if ((this.runningCounts.get(sessionOrRunId) ?? 0) <= 0) return;
    const lease = this.leasePath(sessionOrRunId);
    try {
      const now = new Date();
      fs.utimesSync(lease, now, now);
      return;
    } catch {
      /* fall through to recreate */
    }

    try {
      this.withCoordinationLockSync(sessionOrRunId, () => {
        if ((this.runningCounts.get(sessionOrRunId) ?? 0) <= 0) return;
        if (this.readActiveClaimLocked(sessionOrRunId)) {
          logger.warn(
            "Lease heartbeat lost and GC claim owns id; cannot recreate",
            { id: sessionOrRunId },
          );
          return;
        }
        if (this.hasForeignActiveLeaseLocked(sessionOrRunId)) {
          logger.warn(
            "Lease heartbeat lost and foreign active lease owns id; cannot recreate",
            { id: sessionOrRunId },
          );
          return;
        }
        // Preserve original started_at — never mint a new hard-max window.
        if (!this.leaseStartedAt.has(sessionOrRunId)) {
          this.leaseStartedAt.set(sessionOrRunId, Date.now());
        }
        this.writeLeaseLocked(sessionOrRunId);
        logger.warn("Recreated session lease after heartbeat failure", {
          id: sessionOrRunId,
        });
      });
    } catch (err) {
      logger.warn("Failed to renew session lease heartbeat", {
        id: sessionOrRunId,
        err: String(err),
      });
    }
  }

  private writeLeaseLocked(sessionOrRunId: string): void {
    const createdAt =
      this.leaseStartedAt.get(sessionOrRunId) ?? Date.now();
    if (!this.leaseStartedAt.has(sessionOrRunId)) {
      this.leaseStartedAt.set(sessionOrRunId, createdAt);
    }
    const record: LeaseRecord = {
      owner: this.ownerId,
      pid: process.pid,
      created_at: createdAt,
    };
    fs.writeFileSync(this.leasePath(sessionOrRunId), JSON.stringify(record), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async withLock<T>(fn: (data: SessionStoreData) => Promise<T> | T): Promise<T> {
    await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
    const release = await this.acquireLock();
    try {
      const data = await this.readUnlocked();
      const result = await fn(data);
      await this.writeUnlocked(data);
      return result;
    } finally {
      await release();
    }
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    return this.withLock((data) => data.sessions[sessionId]);
  }

  async upsert(sessionId: string, record: SessionRecord): Promise<void> {
    await this.withLock((data) => {
      data.sessions[sessionId] = record;
      this.prune(data);
    });
  }

  async touch(sessionId: string): Promise<void> {
    await this.withLock((data) => {
      const rec = data.sessions[sessionId];
      if (rec) rec.last_used_at = new Date().toISOString();
    });
  }

  async addPending(pending: PendingWorktree): Promise<void> {
    await this.withLock((data) => {
      data.pending_worktrees.push(pending);
    });
  }

  async removePending(runId: string): Promise<void> {
    await this.withLock((data) => {
      data.pending_worktrees = data.pending_worktrees.filter((p) => p.run_id !== runId);
    });
  }

  async listPending(): Promise<PendingWorktree[]> {
    return this.withLock((data) => [...data.pending_worktrees]);
  }

  /**
   * GC stale pending worktrees and sessions.
   *
   * Candidates are snapshotted first, but each id is re-validated against the
   * live store (created_at / last_used_at vs cutoff, worktree path, active
   * lease) immediately before claim/removal and again before committing the
   * persistent-record deletion. A resume/touch after the snapshot therefore
   * cannot lose its worktree.
   *
   * Each candidate is claimed using a cross-process coordination file before
   * slow removal begins. `markRunning` refuses a live claim or foreign live
   * lease. Dead leases are purged only under the claim lock (atomic with the
   * claim write).
   */
  async gc(
    ttlHours: number,
    removeWorktree: (
      p: PendingWorktree | (SessionRecord & { session_id?: string }),
    ) => Promise<boolean | void>,
  ): Promise<number> {
    const cutoff = Date.now() - ttlHours * 3600_000;

    type PendingCandidate = {
      kind: "pending";
      id: string;
      entry: PendingWorktree;
      /** Snapshot timestamps used to detect refresh before commit. */
      stamp: string;
    };
    type SessionCandidate = {
      kind: "session";
      id: string;
      entry: SessionRecord;
      stamp: string;
    };
    type Candidate = PendingCandidate | SessionCandidate;

    const candidates: Candidate[] = await this.withLock((data) => {
      const out: Candidate[] = [];
      for (const p of data.pending_worktrees) {
        if (this.isRunning(p.run_id)) continue;
        const t = Date.parse(p.created_at);
        if (!Number.isNaN(t) && t < cutoff) {
          out.push({
            kind: "pending",
            id: p.run_id,
            entry: { ...p },
            stamp: p.created_at,
          });
        }
      }
      for (const [id, rec] of Object.entries(data.sessions)) {
        if (this.isRunning(id)) continue;
        const t = Date.parse(rec.last_used_at);
        if (!Number.isNaN(t) && t < cutoff) {
          out.push({
            kind: "session",
            id,
            entry: { ...rec },
            stamp: rec.last_used_at,
          });
        }
      }
      return out;
    });

    type SucceededPending = {
      id: string;
      stamp: string;
      worktree_path: string | undefined;
    };
    type SucceededSession = {
      id: string;
      stamp: string;
      worktree_path: string | undefined;
    };
    const succeededPending: SucceededPending[] = [];
    const succeededSessions: SucceededSession[] = [];
    const claims: Array<{ id: string; token: string; renew: NodeJS.Timeout }> =
      [];

    try {
      for (const c of candidates) {
        // Freshness gate #1: record may have been resumed/touched after snapshot.
        const pre = await this.revalidateGcCandidate(c, cutoff);
        if (!pre.ok) continue;

        const token = this.claimForGc(c.id);
        if (!token) continue;
        // Renew claim expiry for the whole removal — long `rm -rf` / network
        // FS must not let the claim expire mid-flight. Fail-closed: if renewal
        // loses exclusivity, do not commit the persistent-record deletion.
        let claimHealthy = true;
        const renew = setInterval(() => {
          if (!this.renewGcClaim(c.id, token)) claimHealthy = false;
        }, GC_CLAIM_RENEW_MS);
        if (typeof renew.unref === "function") renew.unref();
        claims.push({ id: c.id, token, renew });

        try {
          // Re-check lease after claim (claim holds exclusivity vs markRunning).
          if (this.isRunning(c.id)) {
            logger.warn("Skipping GC; became running after claim", { id: c.id });
            continue;
          }

          const result =
            c.kind === "pending"
              ? await removeWorktree(pre.entry as PendingWorktree)
              : await removeWorktree({
                  ...(pre.entry as SessionRecord),
                  session_id: c.id,
                });
          if (result === false) {
            logger.warn("GC callback reported worktree still present", {
              id: c.id,
              path: pre.entry.worktree_path,
            });
            continue;
          }
          // Re-validate ownership after slow removal.
          if (!claimHealthy || !this.ownsGcClaim(c.id, token)) {
            logger.warn(
              "GC claim lost during removal; not committing record deletion",
              { id: c.id, path: pre.entry.worktree_path },
            );
            continue;
          }
          // Freshness gate #2 snapshot for commit-time compare.
          if (c.kind === "pending") {
            succeededPending.push({
              id: c.id,
              stamp: pre.stamp,
              worktree_path: pre.entry.worktree_path,
            });
          } else {
            succeededSessions.push({
              id: c.id,
              stamp: pre.stamp,
              worktree_path: pre.entry.worktree_path,
            });
          }
        } catch (err) {
          logger.warn(
            c.kind === "pending"
              ? "Failed to GC pending worktree"
              : "Failed to GC session worktree",
            {
              id: c.id,
              path: c.entry.worktree_path,
              err: String(err),
            },
          );
        }
      }

      if (succeededPending.length === 0 && succeededSessions.length === 0) {
        return 0;
      }

      let removed = 0;
      await this.withLock((data) => {
        if (succeededPending.length) {
          const want = new Map(
            succeededPending.map((s) => [s.id, s] as const),
          );
          const nextPending: PendingWorktree[] = [];
          for (const p of data.pending_worktrees) {
            const exp = want.get(p.run_id);
            if (!exp) {
              nextPending.push(p);
              continue;
            }
            // Commit only if still the same stale snapshot (not refreshed /
            // remapped / replaced).
            if (
              p.created_at === exp.stamp &&
              p.worktree_path === exp.worktree_path &&
              !Number.isNaN(Date.parse(p.created_at)) &&
              Date.parse(p.created_at) < cutoff &&
              !this.isRunning(p.run_id)
            ) {
              removed++;
              continue;
            }
            nextPending.push(p);
          }
          data.pending_worktrees = nextPending;
        }

        if (succeededSessions.length) {
          for (const exp of succeededSessions) {
            const rec = data.sessions[exp.id];
            if (!rec) continue;
            if (
              rec.last_used_at === exp.stamp &&
              rec.worktree_path === exp.worktree_path &&
              !Number.isNaN(Date.parse(rec.last_used_at)) &&
              Date.parse(rec.last_used_at) < cutoff &&
              !this.isRunning(exp.id)
            ) {
              delete data.sessions[exp.id];
              removed++;
            }
          }
        }

        this.prune(data);
      });

      return removed;
    } finally {
      for (const claim of claims) {
        clearInterval(claim.renew);
        this.releaseGcClaim(claim.id, claim.token);
      }
    }
  }

  /**
   * Re-read the live store record and confirm it is still a GC candidate.
   * Returns the freshest entry + stamp on success.
   */
  private async revalidateGcCandidate(
    c: {
      kind: "pending" | "session";
      id: string;
      entry: PendingWorktree | SessionRecord;
      stamp: string;
    },
    cutoff: number,
  ): Promise<
    | { ok: true; entry: PendingWorktree | SessionRecord; stamp: string }
    | { ok: false }
  > {
    try {
      return await this.withLock((data) => {
        if (this.isRunning(c.id)) return { ok: false as const };

        if (c.kind === "pending") {
          const p = data.pending_worktrees.find((x) => x.run_id === c.id);
          if (!p) return { ok: false as const };
          // Path remapped / entry replaced — do not delete the new tree.
          if (p.worktree_path !== c.entry.worktree_path) {
            return { ok: false as const };
          }
          const t = Date.parse(p.created_at);
          if (Number.isNaN(t) || t >= cutoff) return { ok: false as const };
          return {
            ok: true as const,
            entry: { ...p },
            stamp: p.created_at,
          };
        }

        const rec = data.sessions[c.id];
        if (!rec) return { ok: false as const };
        if (rec.worktree_path !== c.entry.worktree_path) {
          return { ok: false as const };
        }
        const t = Date.parse(rec.last_used_at);
        if (Number.isNaN(t) || t >= cutoff) return { ok: false as const };
        return {
          ok: true as const,
          entry: { ...rec },
          stamp: rec.last_used_at,
        };
      });
    } catch (err) {
      // Fail closed: skip this candidate rather than risk deleting a live tree.
      logger.warn("Failed to revalidate GC candidate; skipping", {
        id: c.id,
        err: String(err),
      });
      return { ok: false };
    }
  }

  private prune(data: SessionStoreData): void {
    const ids = Object.keys(data.sessions);
    if (ids.length <= this.maxSessions) return;
    const sorted = ids
      .map((id) => ({ id, t: Date.parse(data.sessions[id]!.last_used_at) || 0 }))
      .sort((a, b) => a.t - b.t);
    let remainingToDrop = sorted.length - this.maxSessions;
    for (const item of sorted) {
      if (remainingToDrop <= 0) break;
      if (this.isRunning(item.id)) continue;
      delete data.sessions[item.id];
      remainingToDrop--;
    }
  }

  private coordinationKey(id: string): string {
    return crypto.createHash("sha256").update(id).digest("hex");
  }

  private leasePath(id: string): string {
    return path.join(
      this.leaseDir,
      `${this.coordinationKey(id)}.${this.ownerId}.lease`,
    );
  }

  private claimPath(id: string): string {
    return path.join(this.leaseDir, `${this.coordinationKey(id)}.gc`);
  }

  private coordinationLockPath(id: string): string {
    return path.join(this.leaseDir, `${this.coordinationKey(id)}.lock`);
  }

  private withCoordinationLockSync<T>(id: string, fn: () => T): T {
    fs.mkdirSync(this.leaseDir, { recursive: true, mode: 0o700 });
    const lock = this.coordinationLockPath(id);
    const started = Date.now();
    while (true) {
      try {
        fs.mkdirSync(lock, { mode: 0o700 });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          const stat = fs.statSync(lock);
          if (Date.now() - stat.mtimeMs > COORD_LOCK_STALE_MS) {
            fs.rmSync(lock, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - started > COORD_LOCK_WAIT_MS) {
          throw new Error(`Timeout acquiring session coordination lock: ${lock}`);
        }
        Atomics.wait(SYNC_WAIT, 0, 0, 10);
      }
    }

    try {
      return fn();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  /**
   * @param purgeDead When true, unlink non-live leases for this id. Only the
   *   claim/markRunning paths may set this — pure isRunning probes must not
   *   create a gap a heartbeat can fill with a reset hard-max clock.
   */
  private hasActiveLeaseLocked(
    id: string,
    opts: { purgeDead: boolean } = { purgeDead: false },
  ): boolean {
    const prefix = `${this.coordinationKey(id)}.`;
    const now = Date.now();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.leaseDir);
    } catch {
      return false;
    }
    let active = false;
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".lease")) continue;
      const lease = path.join(this.leaseDir, name);
      try {
        const stat = fs.lstatSync(lease);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          continue;
        }
        if (this.leaseIsLive(lease, stat.mtimeMs, now)) {
          active = true;
        } else if (opts.purgeDead) {
          fs.unlinkSync(lease);
        }
      } catch {
        /* disappeared concurrently */
      }
    }
    return active;
  }

  /** Unlink every non-live lease file for `id`. Caller holds the coord lock. */
  private purgeDeadLeasesLocked(id: string): void {
    this.hasActiveLeaseLocked(id, { purgeDead: true });
  }

  /**
   * True when some *other* owner holds a live lease for this id.
   * Caller holds the coordination lock.
   */
  private hasForeignActiveLeaseLocked(id: string): boolean {
    const prefix = `${this.coordinationKey(id)}.`;
    const ownName = `${this.coordinationKey(id)}.${this.ownerId}.lease`;
    const now = Date.now();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.leaseDir);
    } catch {
      return false;
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".lease")) continue;
      if (name === ownName) continue;
      const lease = path.join(this.leaseDir, name);
      try {
        const stat = fs.lstatSync(lease);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (this.leaseIsLive(lease, stat.mtimeMs, now)) return true;
      } catch {
        /* disappeared */
      }
    }
    return false;
  }

  /**
   * Decide whether a lease file still protects an active run.
   *
   * 1. Fresh heartbeat (mtime within soft TTL) → live, regardless of
   *    created_at. Active runs outlive maxTimeoutMs wall time by design.
   * 2. Stale heartbeat + age past hard max → dead (bounds PID-liveness /
   *    silent stuck owners; recreation must not reset created_at).
   * 3. Stale heartbeat + owner PID still alive + under hard max → live.
   * 4. Dead PID / unparseable legacy past soft TTL → collectible.
   */
  private leaseIsLive(leasePath: string, mtimeMs: number, now: number): boolean {
    // Fresh mtime means the owner is still heartbeating — always protect.
    if (now - mtimeMs <= LEASE_SOFT_TTL_MS) {
      return true;
    }

    let record: LeaseRecord | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(leasePath, "utf8")) as Partial<LeaseRecord>;
      if (
        typeof raw.owner === "string" &&
        typeof raw.pid === "number" &&
        typeof raw.created_at === "number"
      ) {
        record = raw as LeaseRecord;
      }
    } catch {
      record = null;
    }

    if (!record) {
      // Unparseable / legacy lease past soft TTL → fail open for GC.
      return false;
    }

    // PID-liveness is only an extension beyond soft TTL; hard max bounds it.
    if (now - record.created_at > this.leaseHardMaxMs) {
      return false;
    }

    return isProcessAlive(record.pid);
  }

  private readActiveClaimLocked(id: string): GcClaim | null {
    const claimPath = this.claimPath(id);
    try {
      const stat = fs.lstatSync(claimPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const claim = JSON.parse(fs.readFileSync(claimPath, "utf8")) as GcClaim;
      if (
        typeof claim.owner === "string" &&
        typeof claim.expires_at === "number" &&
        claim.expires_at > Date.now()
      ) {
        return claim;
      }
      fs.unlinkSync(claimPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        try {
          fs.unlinkSync(claimPath);
        } catch {
          /* leave malformed claim to its coordination lock owner */
        }
      }
    }
    return null;
  }

  /**
   * Atomically purge dead leases and acquire a GC claim under the coordination
   * lock. Live leases (including hard-max-still-protected ones) refuse the claim.
   * Never leave a window where an expired lease is unlinked but no claim exists.
   */
  private claimForGc(id: string): string | null {
    try {
      return this.withCoordinationLockSync(id, () => {
        if (this.readActiveClaimLocked(id)) return null;
        // Purge + liveness check + claim write are one critical section.
        if (this.hasActiveLeaseLocked(id, { purgeDead: true })) return null;
        const token = `${this.ownerId}-${crypto.randomUUID()}`;
        const claim: GcClaim = {
          owner: token,
          expires_at: Date.now() + GC_CLAIM_TTL_MS,
        };
        fs.writeFileSync(this.claimPath(id), JSON.stringify(claim), {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        return token;
      });
    } catch (err) {
      logger.warn("Failed to claim stale session for GC", {
        id,
        err: String(err),
      });
      return null;
    }
  }

  /**
   * Extend a live GC claim so long removals cannot lose exclusivity.
   * @returns true when this token still owns a live claim after renewal.
   */
  private renewGcClaim(id: string, token: string): boolean {
    try {
      return this.withCoordinationLockSync(id, () => {
        const claimPath = this.claimPath(id);
        try {
          const stat = fs.lstatSync(claimPath);
          if (!stat.isFile() || stat.isSymbolicLink()) return false;
          const claim = JSON.parse(fs.readFileSync(claimPath, "utf8")) as GcClaim;
          if (claim.owner !== token) return false;
          claim.expires_at = Date.now() + GC_CLAIM_TTL_MS;
          fs.writeFileSync(claimPath, JSON.stringify(claim), {
            encoding: "utf8",
            mode: 0o600,
          });
          return true;
        } catch {
          return false;
        }
      });
    } catch (err) {
      logger.warn("Failed to renew GC claim", { id, err: String(err) });
      return false;
    }
  }

  /** True when `token` currently owns a non-expired GC claim for `id`. */
  private ownsGcClaim(id: string, token: string): boolean {
    try {
      return this.withCoordinationLockSync(id, () => {
        const claim = this.readActiveClaimLocked(id);
        return Boolean(claim && claim.owner === token);
      });
    } catch (err) {
      // Fail closed: uncertainty must not commit a store-record deletion.
      logger.warn("Failed to verify GC claim ownership", {
        id,
        err: String(err),
      });
      return false;
    }
  }

  private releaseGcClaim(id: string, token: string): void {
    try {
      this.withCoordinationLockSync(id, () => {
        const claim = this.readActiveClaimLocked(id);
        if (!claim || claim.owner !== token) return;
        try {
          fs.unlinkSync(this.claimPath(id));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      });
    } catch (err) {
      logger.warn("Failed to release GC claim", { id, err: String(err) });
    }
  }

  private async readUnlocked(): Promise<SessionStoreData> {
    try {
      const raw = await fsPromises.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as SessionStoreData;
      if (parsed.version !== 1 || typeof parsed.sessions !== "object") {
        throw new Error("invalid schema");
      }
      if (!Array.isArray(parsed.pending_worktrees)) parsed.pending_worktrees = [];
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return emptyStore();
      const bak = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        await fsPromises.rename(this.filePath, bak);
        logger.error("Session store corrupt; backed up", { bak });
      } catch {
        /* ignore */
      }
      return emptyStore();
    }
  }

  private async writeUnlocked(data: SessionStoreData): Promise<void> {
    const tmp = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    const json = JSON.stringify(data, null, 2);
    await fsPromises.writeFile(tmp, json, { encoding: "utf8", mode: 0o600 });
    const fh = await fsPromises.open(tmp, "r+");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsPromises.rename(tmp, this.filePath);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const start = Date.now();
    while (true) {
      try {
        const fd = fs.openSync(this.lockPath, "wx");
        fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`);
        const heartbeat = setInterval(() => {
          try {
            const now = new Date();
            fs.utimesSync(this.lockPath, now, now);
          } catch {
            /* lock may have been released or stolen */
          }
        }, LOCK_HEARTBEAT_MS);
        if (typeof heartbeat.unref === "function") heartbeat.unref();

        return async () => {
          clearInterval(heartbeat);
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
          try {
            await fsPromises.unlink(this.lockPath);
          } catch {
            /* ignore */
          }
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw err;
        try {
          const stat = await fsPromises.stat(this.lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            await fsPromises.unlink(this.lockPath);
            continue;
          }
        } catch {
          /* retry */
        }
        if (Date.now() - start > LOCK_STALE_MS * 2) {
          throw new Error(`Timeout acquiring session store lock: ${this.lockPath}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }
}
