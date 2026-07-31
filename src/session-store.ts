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
// Soft TTL (mtime): a fresh heartbeat always counts as live.
// Hard max: even a live PID cannot block GC past max tool duration + grace —
// covers crashed hosts and PID reuse without leaving worktrees uncollectible.
// PID liveness: a process suspended longer than the soft TTL still holds the
// lease while its OS process is alive and under the hard max.
/** Soft lease freshness window based on mtime/heartbeat. Exported for tests. */
export const LEASE_SOFT_TTL_MS = 5 * 60_000;
/** @deprecated Use LEASE_SOFT_TTL_MS. Kept for older test imports. */
export const LEASE_TTL_MS = LEASE_SOFT_TTL_MS;
export const LEASE_HEARTBEAT_MS = 10_000;
/** Extra grace beyond max tool duration before a live-PID lease is reaped. */
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
  created_at: number;
}

interface GcClaim {
  owner: string;
  expires_at: number;
}

export interface SessionStoreOptions {
  /**
   * Maximum tool duration this process may run (ms). Bounds the PID-liveness
   * extension when heartbeats go stale: `maxTimeoutMs + LEASE_HARD_GRACE_MS`.
   * Fresh heartbeats always protect the run; hard max only limits how long a
   * silent-but-alive PID can block GC after soft TTL (covers crash + PID reuse).
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
  /** Hard ceiling for lease age even when the owner PID is still alive. */
  private readonly leaseHardMaxMs: number;
  private readonly runningCounts = new Map<string, number>();
  private readonly leaseHeartbeats = new Map<string, NodeJS.Timeout>();

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
      return this.withCoordinationLockSync(id, () =>
        this.hasActiveLeaseLocked(id),
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
   * Refresh lease mtime; on failure (e.g. lease reaped during a long suspend)
   * recreate the lease only while this process still holds the running count
   * and no foreign GC claim owns the id. Heartbeat failures must not silently
   * make an active worktree collectible.
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
        // Recreate even if another stale lease file for this owner disappeared.
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
    const record: LeaseRecord = {
      owner: this.ownerId,
      pid: process.pid,
      created_at: Date.now(),
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
   * Each candidate is claimed using a cross-process coordination file before
   * slow removal begins. `markRunning` refuses a live claim, so another MCP
   * process cannot resume the same session between the lease check and rm.
   * The persistent record is removed only when the callback does not return
   * `false`; failed worktree removals remain retryable instead of becoming
   * orphaned directories.
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
    };
    type SessionCandidate = {
      kind: "session";
      id: string;
      entry: SessionRecord;
    };
    type Candidate = PendingCandidate | SessionCandidate;

    const candidates: Candidate[] = await this.withLock((data) => {
      const out: Candidate[] = [];
      for (const p of data.pending_worktrees) {
        if (this.isRunning(p.run_id)) continue;
        const t = Date.parse(p.created_at);
        if (!Number.isNaN(t) && t < cutoff) {
          out.push({ kind: "pending", id: p.run_id, entry: p });
        }
      }
      for (const [id, rec] of Object.entries(data.sessions)) {
        if (this.isRunning(id)) continue;
        const t = Date.parse(rec.last_used_at);
        if (!Number.isNaN(t) && t < cutoff) {
          out.push({ kind: "session", id, entry: rec });
        }
      }
      return out;
    });

    const succeededPending = new Set<string>();
    const succeededSessions = new Set<string>();
    const claims: Array<{ id: string; token: string; renew: NodeJS.Timeout }> =
      [];

    try {
      for (const c of candidates) {
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
          const result =
            c.kind === "pending"
              ? await removeWorktree(c.entry)
              : await removeWorktree({ ...c.entry, session_id: c.id });
          if (result === false) {
            logger.warn("GC callback reported worktree still present", {
              id: c.id,
              path: c.entry.worktree_path,
            });
            continue;
          }
          // Re-validate ownership after slow removal. A lost/expired claim means
          // another process may have claimed the id — leave the store record so
          // GC can retry rather than silently dropping bookkeeping.
          if (!claimHealthy || !this.ownsGcClaim(c.id, token)) {
            logger.warn(
              "GC claim lost during removal; not committing record deletion",
              { id: c.id, path: c.entry.worktree_path },
            );
            continue;
          }
          if (c.kind === "pending") succeededPending.add(c.entry.run_id);
          else succeededSessions.add(c.id);
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

      if (succeededPending.size === 0 && succeededSessions.size === 0) {
        return 0;
      }

      let removed = 0;
      await this.withLock((data) => {
        if (succeededPending.size) {
          const nextPending: PendingWorktree[] = [];
          for (const p of data.pending_worktrees) {
            if (succeededPending.has(p.run_id)) {
              removed++;
              continue;
            }
            nextPending.push(p);
          }
          data.pending_worktrees = nextPending;
        }

        if (succeededSessions.size) {
          for (const id of succeededSessions) {
            if (data.sessions[id]) {
              delete data.sessions[id];
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

  private hasActiveLeaseLocked(id: string): boolean {
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
        } else {
          fs.unlinkSync(lease);
        }
      } catch {
        /* disappeared concurrently */
      }
    }
    return active;
  }

  /**
   * Decide whether a lease file still protects an active run.
   *
   * 1. Fresh heartbeat (mtime within soft TTL) → live. An actively heartbeating
   *    process must never have its worktree collected mid-run.
   * 2. Stale heartbeat + owner PID still alive + age ≤ hard max → live
   *    (debugger / laptop suspend longer than soft TTL).
   * 3. Stale heartbeat + dead PID, past hard max, or unparseable legacy lease
   *    → collectible (crashed process cannot block GC forever; hard max also
   *    bounds PID-reuse ambiguity for the PID-liveness extension only).
   */
  private leaseIsLive(leasePath: string, mtimeMs: number, now: number): boolean {
    // Fresh mtime means this owner is still heartbeating — always protect.
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

  private claimForGc(id: string): string | null {
    try {
      return this.withCoordinationLockSync(id, () => {
        if (this.readActiveClaimLocked(id)) return null;
        if (this.hasActiveLeaseLocked(id)) return null;
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
