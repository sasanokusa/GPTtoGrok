import type {
  DiffStats,
  EffectiveResponseMode,
  ResponseMode,
} from "./diff-artifact.js";
import type { ExecutionMode, GrokToolResult, TestsResult } from "./types.js";

export function emptyTests(): TestsResult {
  return { ran: false };
}

/** Response-mode block; identical shape whether or not a diff body is returned. */
export interface ResponseModeResultFields {
  requested: ResponseMode;
  effective: EffectiveResponseMode;
  diffIncluded: boolean;
  diffBytes: number;
  diffSha256: string;
  diffStats: DiffStats;
  diffArtifactPath: string | null;
  /** False when anything was dropped from the patch (omission or truncation). */
  diffComplete: boolean;
  /** True only when an absolute byte cap cut the patch body. */
  diffTruncated: boolean;
  /** Byte length before the cap; present only when `diffTruncated`. */
  originalDiffBytes?: number;
  nextActions: string[];
}

export function assembleResult(opts: {
  summary: string;
  changedFiles: string[];
  diff: string;
  tests: TestsResult;
  sessionId: string | null;
  worktreePath: string | null;
  warnings: string[];
  mode: ExecutionMode;
  workingDirectory: string;
  effectiveCwd: string;
  response: ResponseModeResultFields;
  meta: GrokToolResult["meta"];
}): GrokToolResult {
  return {
    result_version: 1,
    summary: opts.summary,
    changed_files: opts.changedFiles,
    diff: opts.diff,
    tests: opts.tests,
    session_id: opts.sessionId,
    worktree_path: opts.worktreePath,
    warnings: opts.warnings,
    mode: opts.mode,
    working_directory: opts.workingDirectory,
    effective_cwd: opts.effectiveCwd,
    response_mode_requested: opts.response.requested,
    response_mode_effective: opts.response.effective,
    diff_included: opts.response.diffIncluded,
    diff_bytes: opts.response.diffBytes,
    diff_sha256: opts.response.diffSha256,
    diff_stats: opts.response.diffStats,
    diff_artifact_path: opts.response.diffArtifactPath,
    diff_complete: opts.response.diffComplete,
    diff_truncated: opts.response.diffTruncated,
    ...(opts.response.originalDiffBytes !== undefined
      ? { original_diff_bytes: opts.response.originalDiffBytes }
      : {}),
    next_actions: opts.response.nextActions,
    meta: opts.meta,
  };
}
