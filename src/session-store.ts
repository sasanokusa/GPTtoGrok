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

  async gc(
    ttlHours: number,
    removeWorktree: (p: PendingWorktree | SessionRecord & { session_id?: string }) => Promise<void>,
  ): Promise<number> {
    const cutoff = Date.now() - ttlHours * 3600_000;
    let removed = 0;
    await this.withLock(async (data) => {
      // pending orphans
      const keepPending: PendingWorktree[] = [];
      for (const p of data.pending_worktrees) {
        if (this.running.has(p.run_id)) {
          keepPending.push(p);
          continue;
        }
        const t = Date.parse(p.created_at);
        if (!Number.isNaN(t) && t < cutoff) {
          try {
            await removeWorktree(p);
            removed++;
          } catch (err) {
            logger.warn("Failed to GC pending worktree", {
              path: p.worktree_path,
              err: String(err),
            });
            keepPending.push(p);
          }
        } else {
          keepPending.push(p);
        }
      }
      data.pending_worktrees = keepPending;

      // old sessions
      const next: Record<string, SessionRecord> = {};
      for (const [id, rec] of Object.entries(data.sessions)) {
        if (this.running.has(id)) {
          next[id] = rec;
          continue;
        }
        const t = Date.parse(rec.last_used_at);
        if (!Number.isNaN(t) && t < cutoff) {
          try {
            await removeWorktree({ ...rec, session_id: id });
            removed++;
          } catch (err) {
            logger.warn("Failed to GC session worktree", {
              session_id: id,
              err: String(err),
            });
            next[id] = rec;
          }
        } else {
          next[id] = rec;
        }
      }
      data.sessions = next;
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
    const staleMs = 10_000;
    while (true) {
      try {
        const fd = fs.openSync(this.lockPath, "wx");
        fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`);
        return async () => {
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
          if (Date.now() - stat.mtimeMs > staleMs) {
            await fsPromises.unlink(this.lockPath);
            continue;
          }
        } catch {
          /* retry */
        }
        if (Date.now() - start > staleMs * 2) {
          throw new Error(`Timeout acquiring session store lock: ${this.lockPath}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }
}
