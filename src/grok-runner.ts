import { spawn, type ChildProcess } from "node:child_process";
import { GrokMcpError } from "./errors.js";
import { logger } from "./log.js";
import { StreamingJsonParser, type ParseResult } from "./streaming-json.js";

export interface GrokRunOptions {
  grokBin: string;
  argv: string[];
  spawnCwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  maxStderrBytes: number;
  /** Called when process is enqueued (for timeout-from-enqueue). */
  enqueuedAt?: number;
}

export interface GrokRunOutcome {
  parse: ParseResult;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

interface QueueItem {
  run: () => Promise<void>;
  reject: (err: unknown) => void;
}

const ENV_SCRUB_KEYS = [
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
];

export function scrubEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: base.HOME,
    USER: base.USER,
    LOGNAME: base.LOGNAME,
    PATH: base.PATH,
    LANG: base.LANG || "C.UTF-8",
    LC_ALL: base.LC_ALL,
    TERM: "dumb",
    NO_COLOR: "1",
    // Grok may need these for auth
    XDG_CONFIG_HOME: base.XDG_CONFIG_HOME,
    XDG_CACHE_HOME: base.XDG_CACHE_HOME,
  };
  // Preserve Grok-related non-secret paths
  for (const [k, v] of Object.entries(base)) {
    if (!v) continue;
    if (k.startsWith("GROK_") && !/KEY|TOKEN|SECRET|PASSWORD/i.test(k)) {
      env[k] = v;
    }
  }
  for (const k of ENV_SCRUB_KEYS) {
    delete env[k];
  }
  return env;
}

export function buildGrokArgv(opts: {
  prompt: string;
  cwd: string;
  resumeSessionId?: string;
  useGrokWorktree?: boolean;
  worktreeName?: string;
  worktreeRef?: string;
  maxTurns?: number;
  model?: string;
  reasoningEffort?: string;
  tools?: string[];
  disallowedTools?: string[];
  noSubagents?: boolean;
  disableWebSearch?: boolean;
  permissionMode?: string;
  alwaysApprove?: boolean;
  sandbox?: string;
  rules?: string;
  verbatim?: boolean;
  restoreCode?: boolean;
  allow?: string[];
  deny?: string[];
}): string[] {
  const argv: string[] = [
    "--no-auto-update",
    "-p",
    opts.prompt,
    "--output-format",
    "streaming-json",
    "--cwd",
    opts.cwd,
  ];

  if (opts.useGrokWorktree && opts.worktreeName && !opts.resumeSessionId) {
    argv.push("-w", opts.worktreeName);
    if (opts.worktreeRef) argv.push("--worktree-ref", opts.worktreeRef);
  }

  if (opts.resumeSessionId) {
    argv.push("-r", opts.resumeSessionId);
  }

  if (opts.maxTurns != null) argv.push("--max-turns", String(opts.maxTurns));
  if (opts.model) argv.push("-m", opts.model);
  if (opts.reasoningEffort) {
    argv.push("--reasoning-effort", opts.reasoningEffort);
  }

  if (opts.tools?.length) argv.push("--tools", opts.tools.join(","));
  if (opts.disallowedTools?.length) {
    argv.push("--disallowed-tools", opts.disallowedTools.join(","));
  }
  if (opts.noSubagents) argv.push("--no-subagents");
  if (opts.disableWebSearch) argv.push("--disable-web-search");

  if (opts.permissionMode) {
    argv.push("--permission-mode", opts.permissionMode);
  } else if (opts.alwaysApprove) {
    argv.push("--always-approve");
  }

  if (opts.sandbox && opts.sandbox !== "off") {
    argv.push("--sandbox", opts.sandbox);
  }
  if (opts.rules) argv.push("--rules", opts.rules);
  if (opts.verbatim) argv.push("--verbatim");
  if (opts.restoreCode) argv.push("--restore-code");

  for (const r of opts.allow ?? []) argv.push("--allow", r);
  for (const r of opts.deny ?? []) argv.push("--deny", r);

  return argv;
}

export class GrokRunner {
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private active = 0;
  private readonly queue: QueueItem[] = [];

  constructor(maxConcurrent = 2, maxQueue = 8) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
  }

  async run(opts: GrokRunOptions): Promise<GrokRunOutcome> {
    const enqueuedAt = opts.enqueuedAt ?? Date.now();
    return new Promise<GrokRunOutcome>((resolve, reject) => {
      if (this.queue.length >= this.maxQueue && this.active >= this.maxConcurrent) {
        reject(
          new GrokMcpError(
            "GROK_MCP_BUSY",
            `Too many concurrent Grok runs (queue depth ${this.maxQueue})`,
          ),
        );
        return;
      }

      const item: QueueItem = {
        reject,
        run: async () => {
          try {
            const remaining = opts.timeoutMs - (Date.now() - enqueuedAt);
            if (remaining <= 0) {
              reject(
                new GrokMcpError("GROK_MCP_TIMEOUT", "Timed out while queued for Grok"),
              );
              return;
            }
            if (opts.signal?.aborted) {
              reject(
                new GrokMcpError("GROK_MCP_CANCELLED", "Cancelled while queued"),
              );
              return;
            }
            const outcome = await this.execute({ ...opts, timeoutMs: remaining });
            resolve(outcome);
          } catch (err) {
            reject(err);
          }
        },
      };
      this.queue.push(item);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.active++;
      void item
        .run()
        .catch((err) => item.reject(err))
        .finally(() => {
          this.active--;
          void this.pump();
        });
    }
  }

  private execute(opts: GrokRunOptions): Promise<GrokRunOutcome> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const parser = new StreamingJsonParser();
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let child: ChildProcess;

      const env = opts.env ?? scrubEnv();

      try {
        child = spawn(opts.grokBin, opts.argv, {
          cwd: opts.spawnCwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (err) {
        const msg = String(err);
        if (/ENOENT|not found/i.test(msg)) {
          reject(
            new GrokMcpError(
              "GROK_MCP_GROK_NOT_FOUND",
              `Grok binary not found: ${opts.grokBin}`,
            ),
          );
          return;
        }
        reject(err);
        return;
      }

      const killGroup = (sig: NodeJS.Signals) => {
        if (child.pid == null) return;
        try {
          process.kill(-child.pid, sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            /* ignore */
          }
        }
      };

      const graceMs = 3000;
      let killTimer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;

      const beginCancel = (reason: "timeout" | "cancel") => {
        if (settled) return;
        if (reason === "timeout") timedOut = true;
        else cancelled = true;
        logger.info("Stopping Grok process group", { reason, pid: child.pid });
        killGroup("SIGTERM");
        graceTimer = setTimeout(() => {
          killGroup("SIGKILL");
        }, graceMs);
      };

      killTimer = setTimeout(() => beginCancel("timeout"), opts.timeoutMs);

      const onAbort = () => beginCancel("cancel");
      if (opts.signal) {
        if (opts.signal.aborted) beginCancel("cancel");
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        parser.push(chunk.toString("utf8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (Buffer.byteLength(stderr, "utf8") > opts.maxStderrBytes) {
          stderr = stderr.slice(-opts.maxStderrBytes);
        }
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        const msg = String(err);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new GrokMcpError(
              "GROK_MCP_GROK_NOT_FOUND",
              `Grok binary not found: ${opts.grokBin}`,
            ),
          );
          return;
        }
        reject(
          new GrokMcpError("GROK_MCP_INTERNAL", `Failed to spawn Grok: ${msg}`),
        );
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        const parse = parser.flush();
        resolve({
          parse,
          exitCode: code,
          signal,
          stderrTail: stderr.slice(-opts.maxStderrBytes),
          durationMs: Date.now() - started,
          timedOut,
          cancelled,
        });
      });

      function cleanup() {
        if (killTimer) clearTimeout(killTimer);
        if (graceTimer) clearTimeout(graceTimer);
        opts.signal?.removeEventListener("abort", onAbort);
      }
    });
  }
}

export function mapRunOutcomeToError(outcome: GrokRunOutcome): GrokMcpError | null {
  const { parse, exitCode, timedOut, cancelled, stderrTail } = outcome;
  if (timedOut) {
    return new GrokMcpError("GROK_MCP_TIMEOUT", "Grok run timed out", {
      exit_code: exitCode ?? undefined,
      stderr_tail: stderrTail,
      partial_summary: parse.text.slice(0, 4000),
      session_id: parse.sessionId,
      warnings: ["PARTIAL_RESULT"],
    });
  }
  if (cancelled || exitCode === 130 || exitCode === 143) {
    return new GrokMcpError("GROK_MCP_CANCELLED", "Grok run cancelled", {
      exit_code: exitCode ?? undefined,
      stderr_tail: stderrTail,
      partial_summary: parse.text.slice(0, 4000),
      session_id: parse.sessionId,
      warnings: cancelled ? ["PARTIAL_RESULT"] : ["EXTERNAL_SIGNAL", "PARTIAL_RESULT"],
    });
  }

  const combined = `${parse.errorMessage ?? ""}\n${stderrTail}`;
  if (/session does not exist|unknown session|invalid session|not found.*session/i.test(combined)) {
    return new GrokMcpError(
      "GROK_MCP_SESSION_NOT_FOUND",
      parse.errorMessage || "Grok session not found",
      { stderr_tail: stderrTail, session_id: parse.sessionId },
    );
  }

  if (exitCode === 0) return null;

  if (parse.errorMessage) {
    return new GrokMcpError("GROK_MCP_GROK_ERROR", parse.errorMessage, {
      exit_code: exitCode ?? undefined,
      stderr_tail: stderrTail,
      partial_summary: parse.text.slice(0, 4000),
      session_id: parse.sessionId,
    });
  }

  return new GrokMcpError(
    "GROK_MCP_GROK_EXIT",
    `Grok exited with code ${exitCode}`,
    {
      exit_code: exitCode ?? undefined,
      stderr_tail: stderrTail,
      partial_summary: parse.text.slice(0, 4000),
      session_id: parse.sessionId,
    },
  );
}
