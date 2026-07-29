import { z } from "zod";
import { GrokMcpError } from "./errors.js";

export const WorkingDirectorySchema = z
  .string()
  .min(1)
  .refine((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p), {
    message: "working_directory must be an absolute path",
  })
  .describe("Absolute path to the project directory (required).");

export const ModeSchema = z.enum(["read_only", "write_worktree"]);

export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan",
]);

/** Permission modes that survive read_only (unsafe values are rejected at runtime). */
export const ReadOnlyPermissionModeSchema = z.enum(["dontAsk", "plan"]);

/**
 * Sandbox profiles that permit mutation / escape in read_only.
 * Single source of truth: `buildModeFlags` rejects these at runtime and
 * {@link ReadOnlySandboxSchema} rejects them at parse time.
 */
export const UNSAFE_READ_ONLY_SANDBOXES = new Set(["off", "workspace"]);

/**
 * Sandbox values that survive read_only. `grok --sandbox <PROFILE>` is free-form,
 * so any profile is allowed except the ones the runtime rejects — do not enumerate,
 * or a future Grok profile becomes unusable here.
 */
export const ReadOnlySandboxSchema = z
  .string()
  .min(1)
  .refine((s) => !UNSAFE_READ_ONLY_SANDBOXES.has(s), {
    message: `sandbox must not be one of: ${[...UNSAFE_READ_ONLY_SANDBOXES].join(", ")} (read_only)`,
  })
  .describe(
    'Grok sandbox profile (--sandbox). Defaults to "read-only"; "off" and "workspace" are rejected in read_only mode.',
  );

/** Canonical Grok CLI --reasoning-effort levels. */
export const REASONING_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number];
export const ReasoningEffortSchema = z
  .enum(REASONING_EFFORT_LEVELS)
  .describe(
    "Grok reasoning effort: none|minimal|low|medium|high|xhigh|max (passed as --reasoning-effort).",
  );

/**
 * Reject test_command when effective mode is read_only (no shell post-hooks).
 * write_worktree tools may still run optional test_command after Grok.
 */
export function rejectTestCommandInReadOnly(
  mode: ExecutionMode,
  testCommand: string | undefined,
): void {
  if (mode === "read_only" && testCommand !== undefined) {
    throw new GrokMcpError(
      "GROK_MCP_INVALID_ARGS",
      "test_command is not supported in read_only mode; use write_worktree or run tests outside the MCP server",
    );
  }
}

export const BaseToolInputSchema = z.object({
  prompt: z.string().min(1),
  working_directory: WorkingDirectorySchema,
  timeout_ms: z.number().int().positive().optional(),
  model: z.string().optional(),
  max_turns: z.number().int().positive().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  test_command: z.string().optional(),
  test_timeout_ms: z.number().int().positive().optional(),
  fail_on_test_failure: z.boolean().optional().default(false),
  include_thoughts: z.boolean().optional().default(false),
  verbatim: z.boolean().optional().default(false),
  rules: z.string().optional(),
  tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  permission_mode: PermissionModeSchema.optional(),
  sandbox: z.string().optional(),
  allow_web: z.boolean().optional().default(false),
  allow_subagents: z.boolean().optional().default(false),
});

/**
 * Schema for grok_analyze (always read_only): omit test fields that are hard-rejected
 * and narrow permission_mode / sandbox to values that survive read_only.
 * Runtime guards remain as defence in depth.
 */
export const AnalyzeInputSchema = BaseToolInputSchema.omit({
  test_command: true,
  test_timeout_ms: true,
  fail_on_test_failure: true,
})
  .extend({
    permission_mode: ReadOnlyPermissionModeSchema.optional(),
    sandbox: ReadOnlySandboxSchema.optional(),
  })
  // Reject unknown keys (e.g. test_command) at parse time — matches JSON Schema
  // additionalProperties: false advertised via tools/list.
  .strict();

export const ImplementInputSchema = BaseToolInputSchema.extend({
  worktree_ref: z.string().optional(),
  worktree_name: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/)
    .max(64)
    .optional(),
  keep_worktree: z.boolean().optional().default(true),
  use_grok_worktree: z.boolean().optional(),
});

export const ReviewInputSchema = BaseToolInputSchema.extend({
  base_ref: z.string().optional().default("HEAD"),
  mode: ModeSchema.optional().default("read_only"),
  inject_diff: z.boolean().optional().default(true),
  worktree_ref: z.string().optional(),
  worktree_name: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/)
    .max(64)
    .optional(),
  keep_worktree: z.boolean().optional().default(true),
});

export const DebugInputSchema = BaseToolInputSchema.extend({
  worktree_ref: z.string().optional(),
  worktree_name: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/)
    .max(64)
    .optional(),
  keep_worktree: z.boolean().optional().default(true),
  mode: ModeSchema.optional().default("write_worktree"),
  use_grok_worktree: z.boolean().optional(),
});

export const ContinueInputSchema = z.object({
  prompt: z.string().min(1),
  working_directory: WorkingDirectorySchema,
  session_id: z
    .string()
    .min(1)
    .describe("Opaque session id from prior result; UUID preferred"),
  mode: ModeSchema.optional(),
  worktree_path: z.string().optional().describe("Override worktree path if known"),
  allow_missing_worktree: z.boolean().optional().default(false),
  allow_unmapped_session: z.boolean().optional().default(false),
  restore_code: z.boolean().optional().default(false),
  timeout_ms: z.number().int().positive().optional(),
  model: z.string().optional(),
  max_turns: z.number().int().positive().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  test_command: z.string().optional(),
  test_timeout_ms: z.number().int().positive().optional(),
  fail_on_test_failure: z.boolean().optional().default(false),
  include_thoughts: z.boolean().optional().default(false),
  verbatim: z.boolean().optional().default(false),
  rules: z.string().optional(),
  tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  permission_mode: PermissionModeSchema.optional(),
  sandbox: z.string().optional(),
  allow_web: z.boolean().optional().default(false),
  allow_subagents: z.boolean().optional().default(false),
  keep_worktree: z.boolean().optional().default(true),
});

export type BaseToolInput = z.infer<typeof BaseToolInputSchema>;
export type AnalyzeInput = z.infer<typeof AnalyzeInputSchema>;
export type ImplementInput = z.infer<typeof ImplementInputSchema>;
export type ReviewInput = z.infer<typeof ReviewInputSchema>;
export type DebugInput = z.infer<typeof DebugInputSchema>;
export type ContinueInput = z.infer<typeof ContinueInputSchema>;
export type ExecutionMode = z.infer<typeof ModeSchema>;

export interface TestsResult {
  ran: boolean;
  command?: string;
  exit_code?: number;
  output?: string;
  parsed?: {
    passed?: number;
    failed?: number;
    skipped?: number;
    framework?: string;
  };
}

export interface GrokToolResult {
  result_version: 1;
  summary: string;
  changed_files: string[];
  diff: string;
  tests: TestsResult;
  session_id: string | null;
  worktree_path: string | null;
  warnings: string[];
  mode: ExecutionMode;
  working_directory: string;
  effective_cwd: string;
  meta: {
    stop_reason?: string;
    usage?: Record<string, unknown>;
    worktree_name?: string;
    grok_worktree_id?: string;
    duration_ms: number;
    exit_code?: number;
    original_tree_status?: string;
    thoughts?: string;
  };
}

export interface SessionRecord {
  mode: ExecutionMode;
  repo_root: string;
  original_cwd: string;
  worktree_path?: string;
  worktree_name?: string;
  grok_worktree_id?: string;
  managed?: boolean;
  created_at: string;
  last_used_at: string;
  tool: string;
}

export interface PendingWorktree {
  run_id: string;
  worktree_path: string;
  worktree_name: string;
  repo_root: string;
  created_at: string;
}

export interface SessionStoreData {
  version: 1;
  pending_worktrees: PendingWorktree[];
  sessions: Record<string, SessionRecord>;
}

export type ToolName =
  | "grok_analyze"
  | "grok_implement"
  | "grok_review"
  | "grok_debug"
  | "grok_continue";
