import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "./log.js";
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
  /**
   * Opt-in absolute cap on the redacted patch body, applied in the response-mode
   * stage. `0` (the default) means unlimited: oversized diffs are moved to an
   * artifact rather than cut. A non-zero value truncates and is reported via
   * `diff_truncated` / `original_diff_bytes`.
   */
  maxDiffBytes: number;
  maxSummaryBytes: number;
  maxPromptDiffBytes: number;
  maxUntrackedFileBytes: number;
  maxStderrBytes: number;
  /**
   * Cap on `tests.output` for a **failing** test run (non-zero exit_code).
   * Passing runs use the smaller `maxTestOutputSuccessBytes` budget instead.
   * Independent of `response_mode` — failure output is never shrunk by compact.
   */
  maxTestOutputBytes: number;
  /**
   * Cap on `tests.output` for a **passing** test run (exit_code === 0).
   * Passing output is almost pure noise; keep it small so it cannot dominate
   * the MCP response after the diff has already been compacted.
   */
  maxTestOutputSuccessBytes: number;
  /** `response_mode: "auto"` inlines the diff while it is <= this many bytes. */
  inlineDiffMaxBytes: number;
  /** Absolute ceiling for an inlined diff; larger bodies degrade to `compact`. */
  inlineDiffHardMaxBytes: number;
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

/** Defaults + hard ceiling for the response-mode byte limits. */
export const DEFAULT_INLINE_DIFF_MAX_BYTES = 65_536;
export const DEFAULT_INLINE_DIFF_HARD_MAX_BYTES = 1_048_576;
export const INLINE_DIFF_BYTES_CEILING = 16 * 1024 * 1024;
/** `0` = unlimited. Truncation is opt-in; oversize alone moves a diff to an artifact. */
export const DEFAULT_MAX_DIFF_BYTES = 0;
export const MAX_DIFF_BYTES_CEILING = 512 * 1024 * 1024;
/**
 * Defaults + hard ceiling for optional `test_command` output.
 * Failure budget matches the historical hard-coded 64 KiB; success is much
 * smaller so a green run cannot blow the MCP response after a compact diff.
 */
export const DEFAULT_MAX_TEST_OUTPUT_BYTES = 65_536;
export const DEFAULT_MAX_TEST_OUTPUT_SUCCESS_BYTES = 4_096;
export const MAX_TEST_OUTPUT_BYTES_CEILING = 16 * 1024 * 1024;

/**
 * Byte-limit env parsing with fail-safe validation.
 * Non-numeric, negative, fractional, NaN and out-of-range values fall back to
 * `fallback` and emit a startup warning on **stderr** (never stdout).
 * `0` is valid and means "never inline".
 */
export function parseByteLimitEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  ceiling: number,
): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  if (!/^\d+$/.test(trimmed)) {
    logger.warn("Invalid byte limit; using default", {
      env: name,
      value: trimmed,
      default: fallback,
    });
    return fallback;
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(n) || n < 0 || n > ceiling) {
    logger.warn("Byte limit out of range; using default", {
      env: name,
      value: trimmed,
      min: 0,
      max: ceiling,
      default: fallback,
    });
    return fallback;
  }
  return n;
}

/** Same validation for values coming from the optional JSON config file. */
export function sanitizeByteLimit(
  name: string,
  value: unknown,
  fallback: number,
  ceiling: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > ceiling
  ) {
    logger.warn("Invalid byte limit in config file; using default", {
      field: name,
      value,
      default: fallback,
    });
    return fallback;
  }
  return value;
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
    maxDiffBytes: parseByteLimitEnv(
      "GROK_MCP_MAX_DIFF_BYTES",
      process.env.GROK_MCP_MAX_DIFF_BYTES,
      sanitizeByteLimit(
        "maxDiffBytes",
        fileCfg.maxDiffBytes,
        DEFAULT_MAX_DIFF_BYTES,
        MAX_DIFF_BYTES_CEILING,
      ),
      MAX_DIFF_BYTES_CEILING,
    ),
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
    maxTestOutputBytes: parseByteLimitEnv(
      "GROK_MCP_MAX_TEST_OUTPUT_BYTES",
      process.env.GROK_MCP_MAX_TEST_OUTPUT_BYTES,
      sanitizeByteLimit(
        "maxTestOutputBytes",
        fileCfg.maxTestOutputBytes,
        DEFAULT_MAX_TEST_OUTPUT_BYTES,
        MAX_TEST_OUTPUT_BYTES_CEILING,
      ),
      MAX_TEST_OUTPUT_BYTES_CEILING,
    ),
    maxTestOutputSuccessBytes: parseByteLimitEnv(
      "GROK_MCP_MAX_TEST_OUTPUT_SUCCESS_BYTES",
      process.env.GROK_MCP_MAX_TEST_OUTPUT_SUCCESS_BYTES,
      sanitizeByteLimit(
        "maxTestOutputSuccessBytes",
        fileCfg.maxTestOutputSuccessBytes,
        DEFAULT_MAX_TEST_OUTPUT_SUCCESS_BYTES,
        MAX_TEST_OUTPUT_BYTES_CEILING,
      ),
      MAX_TEST_OUTPUT_BYTES_CEILING,
    ),
    inlineDiffMaxBytes: parseByteLimitEnv(
      "GROK_MCP_INLINE_DIFF_MAX_BYTES",
      process.env.GROK_MCP_INLINE_DIFF_MAX_BYTES,
      sanitizeByteLimit(
        "inlineDiffMaxBytes",
        fileCfg.inlineDiffMaxBytes,
        DEFAULT_INLINE_DIFF_MAX_BYTES,
        INLINE_DIFF_BYTES_CEILING,
      ),
      INLINE_DIFF_BYTES_CEILING,
    ),
    inlineDiffHardMaxBytes: parseByteLimitEnv(
      "GROK_MCP_INLINE_DIFF_HARD_MAX_BYTES",
      process.env.GROK_MCP_INLINE_DIFF_HARD_MAX_BYTES,
      sanitizeByteLimit(
        "inlineDiffHardMaxBytes",
        fileCfg.inlineDiffHardMaxBytes,
        DEFAULT_INLINE_DIFF_HARD_MAX_BYTES,
        INLINE_DIFF_BYTES_CEILING,
      ),
      INLINE_DIFF_BYTES_CEILING,
    ),
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
  test_command: 300_000,
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
