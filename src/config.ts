import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_DISALLOWED_TOOLS, READ_ONLY_TOOLS } from "./tool-ids.js";

export interface ServerConfig {
  grokBin: string;
  allowedRoots: string[];
  maxConcurrent: number;
  maxQueue: number;
  worktreeTtlHours: number;
  maxSessions: number;
  sandboxWrite: string;
  sandboxReadOnly: string | null;
  useGrokWorktree: boolean;
  failOnOriginalDirty: boolean;
  defaultReadOnlyTools: string[];
  defaultDisallowedTools: string[];
  secretBasenames: string[];
  secretGlobsAggressive: boolean;
  maxTimeoutMs: number;
  maxDiffBytes: number;
  maxSummaryBytes: number;
  maxPromptDiffBytes: number;
  maxUntrackedFileBytes: number;
  maxStderrBytes: number;
  cacheDir: string;
  sessionStorePath: string;
  worktreesRoot: string;
}

const DEFAULT_SECRET_BASENAMES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "auth.json",
  "id_rsa",
  "id_ed25519",
  "id_dsa",
  "id_ecdsa",
  "credentials.json",
  "service-account.json",
];

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function parseIntEnv(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

function defaultGrokBin(): string {
  const candidates = [
    process.env.GROK_MCP_GROK_BIN,
    path.join(os.homedir(), ".grok", "bin", "grok"),
    "grok",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c === "grok") return c;
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* try next */
    }
  }
  return "grok";
}

function loadOptionalJsonConfig(): Partial<ServerConfig> {
  const candidates = [
    process.env.GROK_MCP_CONFIG,
    path.join(os.homedir(), ".config", "codex-grok-mcp", "config.json"),
  ].filter(Boolean) as string[];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ServerConfig>;
      }
    } catch {
      /* ignore corrupt optional config */
    }
  }
  return {};
}

export function loadConfig(): ServerConfig {
  const fileCfg = loadOptionalJsonConfig();
  const cacheDir =
    process.env.GROK_MCP_CACHE_DIR ||
    path.join(
      process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
      "codex-grok-mcp",
    );

  const allowedRootsEnv = process.env.GROK_MCP_ALLOWED_ROOTS;
  const allowedRoots = allowedRootsEnv
    ? allowedRootsEnv.split(":").map((p) => path.resolve(expandHome(p.trim()))).filter(Boolean)
    : fileCfg.allowedRoots?.map((p) => path.resolve(expandHome(p))) ?? [
        path.resolve(os.homedir()),
      ];

  return {
    grokBin: process.env.GROK_MCP_GROK_BIN || fileCfg.grokBin || defaultGrokBin(),
    allowedRoots,
    maxConcurrent: parseIntEnv(process.env.GROK_MCP_MAX_CONCURRENT, fileCfg.maxConcurrent ?? 2),
    maxQueue: parseIntEnv(process.env.GROK_MCP_MAX_QUEUE, fileCfg.maxQueue ?? 8),
    worktreeTtlHours: parseIntEnv(
      process.env.GROK_MCP_WORKTREE_TTL_HOURS,
      fileCfg.worktreeTtlHours ?? 72,
    ),
    maxSessions: parseIntEnv(process.env.GROK_MCP_MAX_SESSIONS, fileCfg.maxSessions ?? 500),
    sandboxWrite:
      process.env.GROK_MCP_SANDBOX || fileCfg.sandboxWrite || "workspace",
    sandboxReadOnly: parseBool(process.env.GROK_MCP_SANDBOX_READ_ONLY, false)
      ? "read-only"
      : fileCfg.sandboxReadOnly ?? null,
    useGrokWorktree: parseBool(
      process.env.GROK_MCP_USE_GROK_WORKTREE,
      fileCfg.useGrokWorktree ?? false,
    ),
    failOnOriginalDirty: parseBool(
      process.env.GROK_MCP_FAIL_ON_ORIGINAL_DIRTY,
      fileCfg.failOnOriginalDirty ?? false,
    ),
    defaultReadOnlyTools: fileCfg.defaultReadOnlyTools ?? [...READ_ONLY_TOOLS],
    defaultDisallowedTools: fileCfg.defaultDisallowedTools ?? [
      ...DEFAULT_DISALLOWED_TOOLS,
    ],
    secretBasenames: fileCfg.secretBasenames ?? DEFAULT_SECRET_BASENAMES,
    secretGlobsAggressive: parseBool(
      process.env.GROK_MCP_SECRET_AGGRESSIVE,
      fileCfg.secretGlobsAggressive ?? false,
    ),
    maxTimeoutMs: parseIntEnv(process.env.GROK_MCP_MAX_TIMEOUT_MS, 3_600_000),
    maxDiffBytes: parseIntEnv(process.env.GROK_MCP_MAX_DIFF_BYTES, 1_048_576),
    maxSummaryBytes: parseIntEnv(process.env.GROK_MCP_MAX_SUMMARY_BYTES, 512_000),
    maxPromptDiffBytes: parseIntEnv(
      process.env.GROK_MCP_MAX_PROMPT_DIFF_BYTES,
      262_144,
    ),
    maxUntrackedFileBytes: parseIntEnv(
      process.env.GROK_MCP_MAX_UNTRACKED_FILE_BYTES,
      524_288,
    ),
    maxStderrBytes: parseIntEnv(process.env.GROK_MCP_MAX_STDERR_BYTES, 64_000),
    cacheDir,
    sessionStorePath: path.join(cacheDir, "sessions.json"),
    worktreesRoot: path.join(cacheDir, "worktrees"),
  };
}

export const DEFAULT_TIMEOUTS_MS = {
  grok_analyze: 600_000,
  grok_review: 600_000,
  grok_implement: 1_800_000,
  grok_debug: 1_800_000,
  grok_continue: 1_200_000,

} as const;

export const SECRET_READ_DENY_RULES = [
  "Read(**/.env)",
  "Read(**/.env.*)",
  "Read(**/*.pem)",
  "Read(**/*.key)",
  "Read(**/id_rsa)",
  "Read(**/id_ed25519)",
  "Read(**/auth.json)",
  "Read(**/credentials.json)",
];
