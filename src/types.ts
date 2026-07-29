import { z } from "zod";

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

/** Canonical Grok CLI --reasoning-effort levels. */
export const REASONING_EFFORT_LEVELS = ["low", "medium", "high"] as const;
export const ReasoningEffortSchema = z
  .enum(REASONING_EFFORT_LEVELS)
  .describe("Grok reasoning effort: low | medium | high (passed as --reasoning-effort).");

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
