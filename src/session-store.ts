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
const LEASE_TTL_MS = 5 * 60_000;
const LEASE_HEARTBEAT_MS = 10_000;
const GC_CLAIM_TTL_MS = 15 * 60_000;
const COORD_LOCK_STALE_MS = 30_000;
const COORD_LOCK_WAIT_MS = 2_000;
const SYNC_WAIT = new Int32Array(new SharedArrayBuffer(4));

interface GcClaim {
  owner: string;
  expires_at: number;
}

export class SessionStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly leaseDir: string;
  private readonly ownerId: string;
  private readonly maxSessions: number;
  private readonly runningCounts = new Map<string, number>();
  private readonly leaseHeartbeats = new Map<string, NodeJS.Timeout>();

  constructor(filePath: string, maxSessions = 500) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.leaseDir = `${filePath}.leases`;
    this.ownerId = `${process.pid}-${crypto.randomUUID()}`;
    this.maxSessions = maxSessions;
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
      fs.writeFileSync(
        this.leasePath(sessionOrRunId),
        JSON.stringify({ owner: this.ownerId, created_at: Date.now() }),
        { encoding: "utf8", mode: 0o600 },
      );
    });

    this.runningCounts.set(sessionOrRunId, 1);
    const heartbeat = setInterval(() => {
      try {
        const now = new Date();
        fs.utimesSync(this.leasePath(sessionOrRunId), now, now);
      } catch {
        // A stale lease may have been reaped after a very long process pause.
        // Never recreate it blindly: a GC claim may now own the identifier.
      }
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
      // A leaked lease expires by TTL; cleanup must not mask the tool result.
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
    const claims: Array<{ id: string; token: string }> = [];

    try {
      for (const c of candidates) {
        const token = this.claimForGc(c.id);
        if (!token) continue;
        claims.push({ id: c.id, token });

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
        if (now - stat.mtimeMs <= LEASE_TTL_MS) {
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
