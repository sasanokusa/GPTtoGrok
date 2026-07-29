import type { ExecutionMode, GrokToolResult, TestsResult } from "./types.js";

export function emptyTests(): TestsResult {
  return { ran: false };
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
    meta: opts.meta,
  };
}
