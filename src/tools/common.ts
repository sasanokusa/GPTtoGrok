import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { ZodError, type z } from "zod";
import type { ServerConfig } from "../config.js";
import { DEFAULT_TIMEOUTS_MS, SECRET_READ_DENY_RULES } from "../config.js";
import {
  applyAbsoluteDiffCap,
  buildNextActions,
  computeDiffStats,
  resolveEffectiveResponseMode,
  sha256Hex,
  writeDiffArtifact,
  type EffectiveResponseMode,
  type ResponseMode,
} from "../diff-artifact.js";
import { GrokMcpError, isGrokMcpError } from "../errors.js";
import {
  assembleDiff,
  getRepoRoot,
  gitStatusPorcelain,
  isGitRepo,
  statusChanged,
} from "../git.js";
import {
  buildGrokArgv,
  GrokRunner,
  mapRunOutcomeToError,
  scrubEnv,
  type GrokRunOutcome,
} from "../grok-runner.js";
import { logger } from "../log.js";
import { shouldDenyRepoRootWrites } from "../path-guard.js";
import { resolveWorkingDirectory } from "../path-guard.js";
import { redactText } from "../redact.js";
import {
  assembleResult,
  emptyTests,
  type ResponseModeResultFields,
} from "../result.js";
import type { SessionStore } from "../session-store.js";
import { narrowReadOnlyTools, unionDisallowedTools } from "../tool-ids.js";
import type {
  ExecutionMode,
  GrokToolResult,
  ReasoningEffort,
  TestsResult,
  ToolName,
} from "../types.js";
import {
  rejectTestCommandInReadOnly,
  UNSAFE_READ_ONLY_SANDBOXES,
} from "../types.js";
import {
  createManagedWorktree,
  pathExists,
  removeWorktree,
} from "../worktree.js";

/**
 * Parse tool args with a Zod schema, converting ZodError into the standard
 * GrokMcpError envelope (error_version: 1) so hosts do not need a second shape.
 * Note: the MCP SDK may still reject against the registered inputSchema before
 * the handler runs; that residual -32602 path is outside our control.
 */
export function parseToolInput<T extends z.ZodTypeAny>(
  schema: T,
  args: unknown,
): z.infer<T> {
  try {
    return schema.parse(args);
  } catch (err) {
    if (err instanceof ZodError) {
      const parts = err.issues.map((issue) => {
        const field = issue.path.length ? issue.path.join(".") : "(root)";
        return `${field}: ${issue.message}`;
      });
      throw new GrokMcpError(
        "GROK_MCP_INVALID_ARGS",
        `Invalid tool arguments: ${parts.join("; ")}`,
        {
          fields: err.issues.map((issue) =>
            issue.path.length ? issue.path.join(".") : "(root)",
          ),
        },
      );
    }
    throw err;
  }
}

export interface ToolContext {
  config: ServerConfig;
  runner: GrokRunner;
  store: SessionStore;
}

export interface RunToolParams {
  tool: ToolName;
  prompt: string;
  workingDirectory: string;
  mode: ExecutionMode;
  timeoutMs?: number;
  model?: string;
  maxTurns?: number;
  reasoningEffort?: ReasoningEffort;
  testCommand?: string;
  testTimeoutMs?: number;
  failOnTestFailure?: boolean;
  includeThoughts?: boolean;
  verbatim?: boolean;
  rules?: string;
  tools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  sandbox?: string;
  allowWeb?: boolean;
  allowSubagents?: boolean;
  /** write only */
  worktreeRef?: string;
  worktreeName?: string;
  keepWorktree?: boolean;
  useGrokWorktree?: boolean;
  /** continue */
  resumeSessionId?: string;
  worktreePathOverride?: string;
  restoreCode?: boolean;
  signal?: AbortSignal;
  /** Optional warnings to merge into the result (e.g. DIFF_UNAVAILABLE from review). */
  extraWarnings?: string[];
  /** How much diff to return. Per-call; defaults to "auto" when omitted. */
  responseMode?: ResponseMode;
}

/**
 * Apply the response mode to an already-redacted diff.
 *
 * Called with `diffAsm.diff` — the single canonical string produced by
 * `assembleDiff` after secret-path hunk filtering and content redaction. There
 * is no path from raw git output to an artifact: `compact` stores exactly the
 * bytes `full` would have inlined.
 *
 * Order is fixed and single-pass: cap (opt-in, off by default) → mode decision →
 * inline or artifact. Only the cap may alter the patch, and when it does the
 * result reports `diff_truncated: true` / `diff_complete: false` so a cut patch
 * is never mistaken for an applyable one. Oversize alone never truncates — it
 * moves the patch to an artifact.
 *
 * Degradation ladder (never inline a huge raw diff as a fallback):
 * - `full` over the hard cap → `compact` + `DIFF_HARD_LIMIT_APPLIED`
 * - artifact write failure → `summary_only` + `DIFF_ARTIFACT_WRITE_FAILED`
 *   (summary / changed_files / worktree_path / stats / hash are all retained)
 */
export async function applyResponseMode(opts: {
  redactedDiff: string;
  /** False when collection dropped changes (secret paths, binary/oversized untracked). */
  sourceComplete: boolean;
  requested: ResponseMode;
  inlineMaxBytes: number;
  inlineHardMaxBytes: number;
  /** Opt-in absolute cap on the patch body; `0` (default) means unlimited. */
  absoluteMaxBytes: number;
  cacheDir: string;
  /** Session id, worktree path or run id — hashed into the artifact directory. */
  artifactScope: string;
  hasWorktree: boolean;
  /** False when `keep_worktree: false` will reap the only other copy of the change. */
  worktreeRetained: boolean;
  warnings: string[];
}): Promise<{ diff: string; response: ResponseModeResultFields }> {
  // Absolute cap first, so every downstream number (bytes, hash, stats) describes
  // the exact body that is returned or stored.
  const capped = applyAbsoluteDiffCap(opts.redactedDiff, opts.absoluteMaxBytes);
  const body = capped.diff;
  if (capped.truncated) opts.warnings.push("DIFF_TRUNCATED");
  const diffComplete = opts.sourceComplete && !capped.truncated;
  if (!diffComplete) opts.warnings.push("DIFF_INCOMPLETE");

  const diffBytes = Buffer.byteLength(body, "utf8");
  const decision = resolveEffectiveResponseMode({
    requested: opts.requested,
    diffBytes,
    inlineMaxBytes: opts.inlineMaxBytes,
    inlineHardMaxBytes: opts.inlineHardMaxBytes,
  });

  let effective: EffectiveResponseMode = decision.effective;
  if (decision.hardLimitApplied) opts.warnings.push("DIFF_HARD_LIMIT_APPLIED");

  let artifactPath: string | null = null;
  if (effective === "compact" && diffBytes > 0) {
    try {
      artifactPath = await writeDiffArtifact({
        cacheDir: opts.cacheDir,
        scope: opts.artifactScope,
        artifactId: crypto.randomUUID(),
        redactedDiff: body,
      });
      opts.warnings.push("DIFF_ARTIFACT_CREATED");
    } catch (err) {
      logger.warn("Failed to write diff artifact; degrading to summary_only", {
        err: String(err),
      });
      opts.warnings.push("DIFF_ARTIFACT_WRITE_FAILED");
      effective = "summary_only";
    }
  }

  const diffIncluded = effective === "full";
  if (!diffIncluded && diffBytes > 0) opts.warnings.push("DIFF_NOT_INLINED");

  // No body, no artifact, and the worktree is about to be reaped: the change
  // would be unrecoverable. Say so loudly rather than returning a quiet result.
  const diffRecoverable =
    diffIncluded ||
    diffBytes === 0 ||
    artifactPath !== null ||
    opts.worktreeRetained;
  if (!diffRecoverable) opts.warnings.push("DIFF_DISCARDED_NO_ARTIFACT");

  return {
    diff: diffIncluded ? body : "",
    response: {
      requested: opts.requested,
      effective,
      diffIncluded,
      diffBytes,
      diffSha256: sha256Hex(body),
      diffStats: computeDiffStats(body),
      diffArtifactPath: artifactPath,
      diffComplete,
      diffTruncated: capped.truncated,
      ...(capped.originalBytes !== undefined
        ? { originalDiffBytes: capped.originalBytes }
        : {}),
      nextActions: buildNextActions(effective, {
        hasWorktree: opts.hasWorktree,
        diffRecoverable,
        diffComplete,
      }),
    },
  };
}

/**
 * Stable content-sensitive digest of an assembled working-tree diff.
 * Includes both path list and patch body so edits to already-dirty files are detected.
 */
export function digestDiffAssembly(asm: {
  changedFiles: string[];
  diff: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(asm.changedFiles.join("\n"))
    .update("\0")
    .update(asm.diff)
    .digest("hex");
}

/**
 * Decide how a read_only run should report working-tree mutations.
 * Inputs are digests from {@link digestDiffAssembly} (or null if unavailable).
 * - baseline null: not a git repo / baseline unavailable → no warning, leave diff as assembled
 * - after null: post-run digest unavailable → no warning, leave diff as assembled
 * - same digest: no warning; suppress pre-existing WIP from returned diff/changed_files
 * - different digest: warn UNEXPECTED_MUTATION and keep the post-run diff
 */
export function evaluateReadOnlyMutation(
  baselineDigest: string | null,
  afterDigest: string | null,
): { unexpectedMutation: boolean; useEmptyDiff: boolean } {
  if (baselineDigest === null || afterDigest === null) {
    return { unexpectedMutation: false, useEmptyDiff: false };
  }
  if (baselineDigest !== afterDigest) {
    return { unexpectedMutation: true, useEmptyDiff: false };
  }
  return { unexpectedMutation: false, useEmptyDiff: true };
}

/**
 * Plan finally-block cleanup for a run's pending_worktrees entry / managed worktree.
 *
 * Rules:
 * 1. Success → drop pending when nothing remains to reap (worktree already removed on
 *    success path, or a session record holds worktree_path for GC). If keepWorktree
 *    was false but the managed path is still present, removal failed — keep pending.
 * 2. Failure + keepWorktree===false + managed worktree still present → remove the
 *    worktree; intent is also to drop pending (call site must KEEP pending if
 *    removeWorktree returns false or throws so GC can retry).
 * 3. Failure + worktree still kept (keep_worktree true/undefined) → keep pending
 *    so SessionStore.gc() can reap at TTL.
 * 4. No managed worktree was created → drop pending (harmless no-op if never added).
 */
export function planRunCleanup(opts: {
  succeeded: boolean;
  managedWorktreePath: string | null;
  keepWorktree: boolean | undefined;
}): { removeWorktree: boolean; removePending: boolean } {
  if (opts.succeeded) {
    // keep_worktree=false but path still present → success-path removal failed; keep pending.
    if (opts.managedWorktreePath && opts.keepWorktree === false) {
      return { removeWorktree: false, removePending: false };
    }
    return { removeWorktree: false, removePending: true };
  }

  if (!opts.managedWorktreePath) {
    return { removeWorktree: false, removePending: true };
  }

  if (opts.keepWorktree === false) {
    return { removeWorktree: true, removePending: true };
  }

  // Failure with worktree retained — keep pending so GC can reap.
  return { removeWorktree: false, removePending: false };
}

/** Permission modes that would undermine read_only isolation. */
const UNSAFE_READ_ONLY_PERMISSION_MODES = new Set([
  "bypassPermissions",
  "acceptEdits",
  "auto",
  "default",
]);


function clampTimeout(ms: number, max: number): number {
  return Math.min(Math.max(1, ms), max);
}

function scaffoldPrompt(tool: ToolName, userPrompt: string, extras?: string): string {
  const headers: Record<ToolName, string> = {
    grok_analyze: [
      "You are performing READ-ONLY analysis of a codebase.",
      "Do not modify any files. Do not run destructive commands.",
      "Never read or quote secrets (.env, private keys, auth.json, credentials).",
    ].join("\n"),
    grok_implement: [
      "You are implementing a change in an isolated git worktree (this is your CWD).",
      "Make minimal, correct diffs. Do not push remotes unless explicitly asked.",
      "Uncommitted WIP from the original tree is NOT included unless already committed.",
      "Never read or include secrets (.env, private keys, auth files) in edits or output.",
    ].join("\n"),
    grok_review: [
      "You are reviewing code changes. List issues by severity (critical/major/minor/nit).",
      "Do not modify files unless write mode was explicitly enabled.",
      "Never request or echo secrets from .env or key files.",
    ].join("\n"),
    grok_debug: [
      "You are debugging an issue. Form hypotheses, gather evidence, and fix if clear.",
      "Prefer small verified fixes. Never include secrets in output.",
    ].join("\n"),
    grok_continue: [
      "Continue the prior Grok session. Respect the same safety rules.",
      "Never include secrets (.env, private keys, auth files) in output.",
    ].join("\n"),
  };
  const parts = [headers[tool], extras, "", "User request:", userPrompt].filter(
    Boolean,
  );
  return parts.join("\n");
}

export function buildModeFlags(
  mode: ExecutionMode,
  cfg: ServerConfig,
  opts: {
    allowWeb?: boolean;
    allowSubagents?: boolean;
    tools?: string[];
    disallowedTools?: string[];
    permissionMode?: string;
    sandbox?: string;
    repoRoot?: string;
    worktreePath?: string;
    useGrokWorktree?: boolean;
  },
): {
  tools?: string[];
  disallowedTools?: string[];
  noSubagents: boolean;
  disableWebSearch: boolean;
  permissionMode?: string;
  alwaysApprove: boolean;
  sandbox?: string;
  deny: string[];
} {
  const deny = [...SECRET_READ_DENY_RULES];
  if (
    mode === "write_worktree" &&
    opts.repoRoot &&
    opts.worktreePath &&
    shouldDenyRepoRootWrites(opts.repoRoot, opts.worktreePath)
  ) {
    deny.push(`Edit(${opts.repoRoot}/**)`);
    deny.push(`Write(${opts.repoRoot}/**)`);
  }

  if (mode === "read_only") {
    if (
      opts.permissionMode &&
      UNSAFE_READ_ONLY_PERMISSION_MODES.has(opts.permissionMode)
    ) {
      throw new GrokMcpError(
        "GROK_MCP_INVALID_ARGS",
        `permission_mode=${opts.permissionMode} is not allowed in read_only mode (forced dontAsk)`,
      );
    }
    if (opts.sandbox && UNSAFE_READ_ONLY_SANDBOXES.has(opts.sandbox)) {
      throw new GrokMcpError(
        "GROK_MCP_INVALID_ARGS",
        `sandbox=${opts.sandbox} is not allowed in read_only mode`,
      );
    }

    return {
      tools: narrowReadOnlyTools(cfg.defaultReadOnlyTools, opts.tools),
      disallowedTools: unionDisallowedTools(
        cfg.defaultDisallowedTools,
        opts.disallowedTools,
      ),
      noSubagents: true,
      disableWebSearch: !opts.allowWeb,
      permissionMode: "dontAsk",
      alwaysApprove: false,
      sandbox: opts.sandbox ?? cfg.sandboxReadOnly ?? "read-only",
      deny,
    };
  }

  // write_worktree
  const sandbox =
    opts.sandbox ??
    (opts.useGrokWorktree ? "off" : cfg.sandboxWrite);

  return {
    tools: opts.tools,
    disallowedTools: opts.disallowedTools,
    noSubagents: !opts.allowSubagents,
    disableWebSearch: !opts.allowWeb,
    permissionMode: opts.permissionMode,
    alwaysApprove: !opts.permissionMode,
    sandbox: sandbox === "off" ? undefined : sandbox,
    deny,
  };
}

async function runTests(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutput: number,
): Promise<TestsResult> {
  return new Promise((resolve) => {
    // Non-login shell: avoid sourcing the user profile (wider blast radius +
    // non-reproducible PATH). test_command still runs on the host outside Grok's
    // sandbox — see README / design doc threat model.
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: scrubEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    const onData = (d: Buffer) => {
      out += d.toString("utf8");
      if (Buffer.byteLength(out, "utf8") > maxOutput) {
        out = out.slice(-maxOutput);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ran: true,
        command,
        exit_code: code ?? 1,
        output: redactText(out, maxOutput),
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ran: true,
        command,
        exit_code: 1,
        output: redactText(String(err), maxOutput),
      });
    });
  });
}

export async function runTool(
  ctx: ToolContext,
  params: RunToolParams,
): Promise<GrokToolResult> {
  const { config, runner, store } = ctx;
  const runId = crypto.randomUUID();
  store.markRunning(runId);
  const warnings: string[] = [];
  if (params.extraWarnings?.length) {
    warnings.push(...params.extraWarnings);
  }
  const started = Date.now();

  // Hoisted so the finally block can clean up pending records / worktrees on failure.
  let worktreePath: string | null = null;
  let repoRoot: string | undefined;
  let managed = false;
  let succeeded = false;

  try {
    rejectTestCommandInReadOnly(params.mode, params.testCommand);

    const resolved = await resolveWorkingDirectory(
      params.workingDirectory,
      config.allowedRoots,
    );
    const workingDirectory = resolved.realpath;
    const defaultTimeout =
      DEFAULT_TIMEOUTS_MS[params.tool] ?? DEFAULT_TIMEOUTS_MS.grok_analyze;
    const timeoutMs = clampTimeout(
      params.timeoutMs ?? defaultTimeout,
      config.maxTimeoutMs,
    );

    let mode = params.mode;
    let effectiveCwd = workingDirectory;
    let worktreeName: string | undefined;
    let originalBaseline = "";
    /** Pre-run content digest for read_only mutation detection; null = not captured. */
    let readOnlyBaselineDigest: string | null = null;
    let useGrokWorktree =
      params.useGrokWorktree ?? config.useGrokWorktree ?? false;
    const redactCfg = {
      secretBasenames: config.secretBasenames,
      aggressive: config.secretGlobsAggressive,
    };
    const diffOpts = {
      maxUntrackedFileBytes: config.maxUntrackedFileBytes,
    };

    // Load prior resume record before runtime worktree setup / cleanup / upsert
    // so managed metadata is preserved across continue (including keepWorktree=false).
    const prior = params.resumeSessionId
      ? await store.get(params.resumeSessionId)
      : undefined;

    // Continue / resume path
    if (params.resumeSessionId) {
      useGrokWorktree = false; // never -w on continue
      if (prior?.managed === true) {
        managed = true;
      }
      if (prior?.worktree_name && !worktreeName) {
        worktreeName = prior.worktree_name;
      }
    }

    if (mode === "write_worktree") {
      const git = await isGitRepo(workingDirectory);
      if (!git) {
        throw new GrokMcpError(
          "GROK_MCP_NOT_A_GIT_REPO",
          "write_worktree requires a git repository; init git or use grok_analyze",
        );
      }
      repoRoot = await getRepoRoot(workingDirectory);
      originalBaseline = await gitStatusPorcelain(repoRoot);
      if (originalBaseline.trim()) {
        warnings.push("ORIGINAL_WIP_NOT_IN_WORKTREE");
      }

      if (params.resumeSessionId) {
        // Resolve worktree for continue
        if (params.worktreePathOverride) {
          worktreePath = params.worktreePathOverride;
        } else if (prior?.worktree_path) {
          worktreePath = prior.worktree_path;
        }
        if (!worktreePath || !(await pathExists(worktreePath))) {
          throw new GrokMcpError(
            "GROK_MCP_WORKTREE_MISSING",
            "write_worktree continue requires an existing worktree_path; refusing to write to the original tree",
            { session_id: params.resumeSessionId },
          );
        }
        effectiveCwd = worktreePath;
      } else if (useGrokWorktree) {
        // Opt-in weaker path: Grok creates worktree
        worktreeName =
          params.worktreeName ||
          `codex-grok-${params.tool.replace(/^grok_/, "")}-${crypto.randomBytes(4).toString("hex")}`;
        effectiveCwd = repoRoot;
      } else {
        // Default: create managed worktree first
        const created = await createManagedWorktree({
          repoRoot,
          worktreesRoot: config.worktreesRoot,
          name: params.worktreeName,
          ref: params.worktreeRef,
          tool: params.tool,
        });
        worktreePath = created.worktreePath;
        worktreeName = created.worktreeName;
        managed = true;
        effectiveCwd = worktreePath;
        await store.addPending({
          run_id: runId,
          worktree_path: worktreePath,
          worktree_name: worktreeName,
          repo_root: repoRoot,
          created_at: new Date().toISOString(),
        });
      }
    } else if (mode === "read_only") {
      // Content-sensitive baseline via assembleDiff (includes untracked file bodies).
      // Not a git repo / failure → skip silently (no baseline, no UNEXPECTED_MUTATION).
      try {
        if (await isGitRepo(workingDirectory)) {
          const baselineAsm = await assembleDiff(
            workingDirectory,
            redactCfg,
            diffOpts,
          );
          readOnlyBaselineDigest = digestDiffAssembly(baselineAsm);
        }
      } catch {
        readOnlyBaselineDigest = null;
      }
    }

    const flags = buildModeFlags(mode, config, {
      allowWeb: params.allowWeb,
      allowSubagents: params.allowSubagents,
      tools: params.tools,
      disallowedTools: params.disallowedTools,
      permissionMode: params.permissionMode,
      sandbox: params.sandbox,
      repoRoot,
      worktreePath: worktreePath ?? undefined,
      useGrokWorktree: useGrokWorktree && mode === "write_worktree" && !params.resumeSessionId,
    });

    const fullPrompt = params.verbatim
      ? params.prompt
      : scaffoldPrompt(params.tool, params.prompt, params.rules);

    const argv = buildGrokArgv({
      prompt: fullPrompt,
      cwd: effectiveCwd,
      resumeSessionId: params.resumeSessionId,
      useGrokWorktree:
        useGrokWorktree && mode === "write_worktree" && !params.resumeSessionId,
      worktreeName,
      worktreeRef: params.worktreeRef,
      maxTurns: params.maxTurns,
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      tools: flags.tools,
      disallowedTools: flags.disallowedTools,
      noSubagents: flags.noSubagents,
      disableWebSearch: flags.disableWebSearch,
      permissionMode: flags.permissionMode,
      alwaysApprove: flags.alwaysApprove,
      sandbox: flags.sandbox,
      rules: params.rules,
      verbatim: params.verbatim,
      restoreCode: params.restoreCode,
      deny: flags.deny,
    });

    logger.info("Spawning Grok", {
      tool: params.tool,
      mode,
      cwd: effectiveCwd,
      worktree_path: worktreePath,
      timeout_ms: timeoutMs,
      argv_preview: argv.filter((a) => a !== fullPrompt).join(" "),
    });

    let outcome: GrokRunOutcome;
    try {
      outcome = await runner.run({
        grokBin: config.grokBin,
        argv,
        spawnCwd: effectiveCwd,
        timeoutMs,
        signal: params.signal,
        maxStderrBytes: config.maxStderrBytes,
      });
    } catch (err) {
      if (isGrokMcpError(err)) throw err;
      throw new GrokMcpError("GROK_MCP_INTERNAL", String(err));
    }

    // Discover worktree for opt-in -w path (best effort: worktree name under .git)
    if (
      mode === "write_worktree" &&
      useGrokWorktree &&
      !worktreePath &&
      worktreeName &&
      repoRoot
    ) {
      // Grok places worktrees in its managed location; leave null if unknown
      // Caller can still get session_id and diff if cwd was switched — we inspect repoRoot changes carefully
      warnings.push("GROK_NATIVE_WORKTREE_PATH_UNKNOWN");
    }

    const parse = outcome.parse;
    warnings.push(...parse.parseWarnings.map((w) => `PARSE:${w}`));
    if (parse.maxTurnsReached) warnings.push("MAX_TURNS_REACHED");

    // Collect git state
    const inspectCwd =
      mode === "write_worktree" && worktreePath ? worktreePath : effectiveCwd;
    let diffAsm = await assembleDiff(inspectCwd, redactCfg, diffOpts);
    warnings.push(...diffAsm.warnings);

    if (mode === "read_only") {
      const afterDigest =
        readOnlyBaselineDigest !== null
          ? digestDiffAssembly(diffAsm)
          : null;
      const decision = evaluateReadOnlyMutation(
        readOnlyBaselineDigest,
        afterDigest,
      );
      if (decision.unexpectedMutation) {
        warnings.push("UNEXPECTED_MUTATION");
      }
      if (decision.useEmptyDiff) {
        // Do not surface the caller's pre-existing uncommitted work. Suppressing
        // an unchanged baseline is not an omission: the run itself changed nothing.
        diffAsm = {
          changedFiles: [],
          diff: "",
          warnings: diffAsm.warnings,
          complete: true,
        };
      }
    }

    let originalTreeStatus: string | undefined;
    if (mode === "write_worktree" && repoRoot) {
      try {
        const after = await gitStatusPorcelain(repoRoot);
        if (statusChanged(originalBaseline, after)) {
          // Filter pure worktree bookkeeping: if only .git/worktrees related — still report
          warnings.push("ORIGINAL_TREE_DIRTY");
          originalTreeStatus = redactText(after, 4000);
          if (config.failOnOriginalDirty) {
            throw new GrokMcpError(
              "GROK_MCP_ORIGINAL_TREE_DIRTY",
              "Original repository tree was modified during write_worktree run",
              {
                session_id: parse.sessionId,
                worktree_path: worktreePath,
                warnings: [...warnings],
              },
            );
          }
        }
      } catch (err) {
        if (isGrokMcpError(err)) throw err;
        logger.warn("Failed original tree dirty check", { err: String(err) });
      }
    }

    // Map errors — but allow partial success with diff
    const mapped = mapRunOutcomeToError(outcome);
    if (mapped) {
      const hasUseful =
        Boolean(diffAsm.diff.trim()) || Boolean(parse.text.trim());
      const isCancel =
        mapped.code === "GROK_MCP_CANCELLED" || mapped.code === "GROK_MCP_TIMEOUT";
      if (isCancel || !hasUseful) {
        throw new GrokMcpError(mapped.code, mapped.message, {
          ...mapped.details,
          worktree_path: worktreePath,
          warnings: [...(mapped.details?.warnings ?? []), ...warnings],
        });
      }
      warnings.push("GROK_NONZERO_EXIT");
    }

    let tests: TestsResult = emptyTests();
    if (params.testCommand) {
      tests = await runTests(
        params.testCommand,
        inspectCwd,
        clampTimeout(
          params.testTimeoutMs ?? DEFAULT_TIMEOUTS_MS.test_command,
          config.maxTimeoutMs,
        ),
        64_000,
      );
      if (params.failOnTestFailure && tests.exit_code !== 0) {
        throw new GrokMcpError(
          "GROK_MCP_TESTS_FAILED",
          `test_command exited with ${tests.exit_code}`,
          {
            session_id: parse.sessionId,
            worktree_path: worktreePath,
            warnings,
          },
        );
      }
    }

    const summary = redactText(parse.text, config.maxSummaryBytes);
    const sessionId = parse.sessionId;

    // Response-mode decision runs on the fully redacted diff, before any
    // keep_worktree=false cleanup, so a compact artifact still exists after the
    // worktree is reaped.
    const responseMode = await applyResponseMode({
      redactedDiff: diffAsm.diff,
      sourceComplete: diffAsm.complete,
      requested: params.responseMode ?? "auto",
      inlineMaxBytes: config.inlineDiffMaxBytes,
      inlineHardMaxBytes: config.inlineDiffHardMaxBytes,
      absoluteMaxBytes: config.maxDiffBytes,
      cacheDir: config.cacheDir,
      artifactScope: sessionId ?? worktreePath ?? runId,
      hasWorktree: Boolean(worktreePath),
      worktreeRetained: Boolean(worktreePath) && params.keepWorktree !== false,
      warnings,
    });

    if (sessionId) {
      store.markRunning(sessionId);
      // Preserve managed / created_at / repo_root / worktree_name on resume upsert
      await store.upsert(sessionId, {
        mode,
        repo_root: prior?.repo_root ?? repoRoot ?? workingDirectory,
        original_cwd: prior?.original_cwd ?? workingDirectory,
        worktree_path: worktreePath ?? prior?.worktree_path ?? undefined,
        worktree_name: prior?.worktree_name ?? worktreeName,
        grok_worktree_id: prior?.grok_worktree_id,
        managed: prior?.managed ?? managed,
        created_at: prior?.created_at ?? new Date().toISOString(),
        last_used_at: new Date().toISOString(),
        tool: params.tool,
      });
      store.markDone(sessionId);
    }

    // Optional cleanup — only managed paths under worktreesRoot.
    // On resume, `managed` is restored from the prior session record above.
    // Pending removal and failure-path worktree cleanup happen in `finally`.
    if (
      params.keepWorktree === false &&
      worktreePath &&
      repoRoot &&
      managed
    ) {
      try {
        const removed = await removeWorktree(
          repoRoot,
          worktreePath,
          config.worktreesRoot,
        );
        if (removed) {
          worktreePath = null; // prevent double-remove; pending may drop in finally
        } else {
          // Path stays in the result; planRunCleanup keeps pending for GC retry.
          logger.warn("keep_worktree=false but worktree still present after remove", {
            worktreePath,
          });
        }
      } catch (err) {
        logger.warn("keep_worktree=false removeWorktree threw", {
          worktreePath,
          err: String(err),
        });
        // worktreePath remains so pending is retained
      }
    }

    succeeded = true;
    return assembleResult({
      summary,
      changedFiles: diffAsm.changedFiles,
      diff: responseMode.diff,
      tests,
      sessionId,
      worktreePath,
      warnings: [...new Set(warnings)],
      mode,
      workingDirectory,
      effectiveCwd: inspectCwd,
      response: responseMode.response,
      meta: {
        stop_reason: parse.stopReason,
        usage: parse.usage,
        worktree_name: worktreeName,
        duration_ms: Date.now() - started,
        exit_code: outcome.exitCode ?? undefined,
        original_tree_status: originalTreeStatus,
        ...(params.includeThoughts && parse.thoughts
          ? { thoughts: redactText(parse.thoughts, 64_000) }
          : {}),
      },
    });
  } finally {
    const cleanup = planRunCleanup({
      succeeded,
      managedWorktreePath: managed && worktreePath ? worktreePath : null,
      keepWorktree: params.keepWorktree,
    });

    let worktreeRemovalFailed = false;
    if (cleanup.removeWorktree && worktreePath && repoRoot && managed) {
      try {
        const removed = await removeWorktree(
          repoRoot,
          worktreePath,
          config.worktreesRoot,
        );
        // false return is the common failure mode (removeWorktree swallows most errors).
        if (!removed) {
          worktreeRemovalFailed = true;
          logger.warn("worktree cleanup on failure path did not remove path", {
            worktreePath,
          });
        }
      } catch (err) {
        // Keep the pending record so SessionStore.gc() can retry later.
        worktreeRemovalFailed = true;
        logger.warn("worktree cleanup on failure path failed", {
          worktreePath,
          err: String(err),
        });
      }
    }

    // Drop pending only when nothing is left to reap. If we intended to remove
    // a managed worktree and that failed (false or throw), keep pending for GC.
    if (cleanup.removePending && !worktreeRemovalFailed) {
      try {
        await store.removePending(runId);
      } catch (err) {
        logger.warn("removePending failed during cleanup", {
          runId,
          err: String(err),
        });
      }
    }

    store.markDone(runId);
  }
}

export function toolErrorToMcp(err: unknown): {
  isError: true;
  text: string;
} {
  if (isGrokMcpError(err)) {
    return { isError: true, text: JSON.stringify(err.toBody(), null, 2) };
  }
  const body = new GrokMcpError(
    "GROK_MCP_INTERNAL",
    err instanceof Error ? err.message : String(err),
  ).toBody();
  return { isError: true, text: JSON.stringify(body, null, 2) };
}
