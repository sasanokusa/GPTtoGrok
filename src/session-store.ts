import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { PendingWorktree, SessionRecord, SessionStoreData } from "./types.js";
import { logger } from "./log.js";

const emptyStore = (): SessionStoreData => ({
  version: 1,
  pending_worktrees: [],
  sessions: {},
});

const LOCK_STALE_MS = 10_000;
const LOCK_HEARTBEAT_MS = 2_000;

export class SessionStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly maxSessions: number;
  private readonly running = new Set<string>();

  constructor(filePath: string, maxSessions = 500) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.maxSessions = maxSessions;
  }

  markRunning(sessionOrRunId: string): void {
    this.running.add(sessionOrRunId);
  }

  markDone(sessionOrRunId: string): void {
    this.running.delete(sessionOrRunId);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
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
   * Slow work (removeWorktree / git) runs **outside** the file lock so another
   * process cannot treat a long GC as a stale lock and corrupt sessions.json.
   * Snapshot candidates under the lock, remove unlocked, then re-lock and apply
   * only for entries that are still present and still not in `this.running`.
   */
  async gc(
    ttlHours: number,
    removeWorktree: (p: PendingWorktree | SessionRecord & { session_id?: string }) => Promise<void>,
  ): Promise<number> {
    const cutoff = Date.now() - ttlHours * 3600_000;

    type PendingCandidate = { kind: "pending"; entry: PendingWorktree };
    type SessionCandidate = {
      kind: "session";
      id: string;
      entry: SessionRecord;
    };
    type Candidate = PendingCandidate | SessionCandidate;

    const candidates: Candidate[] = await this.withLock((data) => {
      const out: Candidate[] = [];
      for (const p of data.pending_worktrees) {
        if (this.running.has(p.run_id)) continue;
        const t = Date.parse(p.created_at);
        if (!Number.isNaN(t) && t < cutoff) {
          out.push({ kind: "pending", entry: p });
        }
      }
      for (const [id, rec] of Object.entries(data.sessions)) {
        if (this.running.has(id)) continue;
        const t = Date.parse(rec.last_used_at);
        if (!Number.isNaN(t) && t < cutoff) {
          out.push({ kind: "session", id, entry: rec });
        }
      }
      return out;
    });

    const succeededPending = new Set<string>();
    const succeededSessions = new Set<string>();

    for (const c of candidates) {
      // Re-check running before slow work (may have started after snapshot).
      if (c.kind === "pending") {
        if (this.running.has(c.entry.run_id)) continue;
        try {
          await removeWorktree(c.entry);
          succeededPending.add(c.entry.run_id);
        } catch (err) {
          logger.warn("Failed to GC pending worktree", {
            path: c.entry.worktree_path,
            err: String(err),
          });
        }
      } else {
        if (this.running.has(c.id)) continue;
        try {
          await removeWorktree({ ...c.entry, session_id: c.id });
          succeededSessions.add(c.id);
        } catch (err) {
          logger.warn("Failed to GC session worktree", {
            session_id: c.id,
            err: String(err),
          });
        }
      }
    }

    if (succeededPending.size === 0 && succeededSessions.size === 0) {
      return 0;
    }

    let removed = 0;
    await this.withLock((data) => {
      // Re-read current data (withLock already did); only drop entries that are
      // still present and still not running — never overwrite with a stale snapshot.
      if (succeededPending.size) {
        const nextPending: PendingWorktree[] = [];
        for (const p of data.pending_worktrees) {
          if (succeededPending.has(p.run_id) && !this.running.has(p.run_id)) {
            removed++;
            continue;
          }
          nextPending.push(p);
        }
        data.pending_worktrees = nextPending;
      }

      if (succeededSessions.size) {
        for (const id of succeededSessions) {
          if (data.sessions[id] && !this.running.has(id)) {
            delete data.sessions[id];
            removed++;
          }
        }
      }

      this.prune(data);
    });

    return removed;
  }

  private prune(data: SessionStoreData): void {
    const ids = Object.keys(data.sessions);
    if (ids.length <= this.maxSessions) return;
    const sorted = ids
      .map((id) => ({ id, t: Date.parse(data.sessions[id]!.last_used_at) || 0 }))
      .sort((a, b) => a.t - b.t);
    const drop = sorted.length - this.maxSessions;
    for (let i = 0; i < drop; i++) {
      const id = sorted[i]!.id;
      if (!this.running.has(id)) delete data.sessions[id];
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
      // corrupt
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
    await fsPromises.writeFile(tmp, json, "utf8");
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
        // Refresh mtime while held so slow critical sections are not declared stale.
        const heartbeat = setInterval(() => {
          try {
            const now = new Date();
            fs.utimesSync(this.lockPath, now, now);
          } catch {
            /* lock may have been released or stolen */
          }
        }, LOCK_HEARTBEAT_MS);
        // Don't keep the process alive solely for the heartbeat.
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
        // stale lock?
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
