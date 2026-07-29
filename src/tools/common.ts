import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { ServerConfig } from "../config.js";
import { DEFAULT_TIMEOUTS_MS, SECRET_READ_DENY_RULES } from "../config.js";
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
import { assembleResult, emptyTests } from "../result.js";
import type { SessionStore } from "../session-store.js";
import type {
  ExecutionMode,
  GrokToolResult,
  TestsResult,
  ToolName,
} from "../types.js";
import {
  createManagedWorktree,
  pathExists,
  removeWorktree,
} from "../worktree.js";

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
}

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
    return {
      tools: opts.tools ?? cfg.defaultReadOnlyTools,
      disallowedTools: opts.disallowedTools ?? cfg.defaultDisallowedTools,
      noSubagents: !opts.allowSubagents,
      disableWebSearch: !opts.allowWeb,
      permissionMode: opts.permissionMode ?? "dontAsk",
      alwaysApprove: false,
      sandbox: opts.sandbox ?? cfg.sandboxReadOnly ?? undefined,
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
    const child = spawn("/bin/sh", ["-lc", command], {
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
  const started = Date.now();

  try {
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
    let worktreePath: string | null = null;
    let worktreeName: string | undefined;
    let repoRoot: string | undefined;
    let originalBaseline = "";
    let managed = false;
    let useGrokWorktree =
      params.useGrokWorktree ?? config.useGrokWorktree ?? false;

    // Continue / resume path
    if (params.resumeSessionId) {
      useGrokWorktree = false; // never -w on continue
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
    const redactCfg = {
      secretBasenames: config.secretBasenames,
      aggressive: config.secretGlobsAggressive,
    };
    const inspectCwd =
      mode === "write_worktree" && worktreePath ? worktreePath : effectiveCwd;
    const diffAsm = await assembleDiff(inspectCwd, redactCfg, {
      maxDiffBytes: config.maxDiffBytes,
      maxUntrackedFileBytes: config.maxUntrackedFileBytes,
    });
    warnings.push(...diffAsm.warnings);

    if (mode === "read_only" && (diffAsm.changedFiles.length || diffAsm.diff.trim())) {
      warnings.push("UNEXPECTED_MUTATION");
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

    if (sessionId) {
      store.markRunning(sessionId);
      await store.upsert(sessionId, {
        mode,
        repo_root: repoRoot ?? workingDirectory,
        original_cwd: workingDirectory,
        worktree_path: worktreePath ?? undefined,
        worktree_name: worktreeName,
        managed,
        created_at: new Date().toISOString(),
        last_used_at: new Date().toISOString(),
        tool: params.tool,
      });
      store.markDone(sessionId);
    }

    await store.removePending(runId);

    // Optional cleanup
    if (
      params.keepWorktree === false &&
      worktreePath &&
      repoRoot &&
      managed
    ) {
      await removeWorktree(repoRoot, worktreePath);
      worktreePath = null;
    }

    return assembleResult({
      summary,
      changedFiles: diffAsm.changedFiles,
      diff: diffAsm.diff,
      tests,
      sessionId,
      worktreePath,
      warnings: [...new Set(warnings)],
      mode,
      workingDirectory,
      effectiveCwd: inspectCwd,
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
