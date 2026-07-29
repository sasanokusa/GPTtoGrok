import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs/promises";
import { GrokMcpError } from "../errors.js";
import { getRepoRoot } from "../git.js";
import { normalizeForCompare, resolveWorkingDirectory } from "../path-guard.js";
import { ContinueInputSchema } from "../types.js";
import type { ToolContext } from "./common.js";
import { parseToolInput, runTool, toolErrorToMcp } from "./common.js";
import {
  assertServerManagedWorktree,
  pathExists,
  resolveWorktreeRealpath,
} from "../worktree.js";

export function registerContinue(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "grok_continue",
    {
      title: "Grok Continue (resume session)",
      description:
        "Resume a prior Grok session via --resume <session_id>. Pass the exact session_id from a previous result. Optional response_mode (auto|full|compact|summary_only) applies to this call only and defaults to auto (never inherited from the session). Never creates a new worktree (-w). If prior mode was write_worktree and worktree is missing, fails closed unless allow_missing_worktree downgrades to read_only (cannot combine with mode=write_worktree).",
      inputSchema: ContinueInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        const input = parseToolInput(ContinueInputSchema, args);

        if (input.mode === "write_worktree" && input.allow_missing_worktree) {
          throw new GrokMcpError(
            "GROK_MCP_INVALID_ARGS",
            "allow_missing_worktree cannot be combined with mode=write_worktree",
          );
        }

        const stored = await ctx.store.get(input.session_id);
        let mode = input.mode ?? stored?.mode;
        let worktreePath = input.worktree_path ?? stored?.worktree_path;

        if (!mode) {
          if (worktreePath) mode = "write_worktree";
          else if (input.allow_unmapped_session) mode = "read_only";
          else {
            throw new GrokMcpError(
              "GROK_MCP_SESSION_NOT_FOUND",
              "Unknown session and no mode/worktree_path provided. Pass mode or allow_unmapped_session for read_only resume.",
              { session_id: input.session_id },
            );
          }
        }

        const warnings: string[] = [];

        if (mode === "write_worktree") {
          // Fail closed: write continue requires a stored MCP session record.
          if (!stored) {
            throw new GrokMcpError(
              "GROK_MCP_SESSION_NOT_FOUND",
              "write_worktree continue requires a stored MCP session record; unmapped write sessions are rejected",
              { session_id: input.session_id },
            );
          }
          if (stored.mode !== "write_worktree") {
            throw new GrokMcpError(
              "GROK_MCP_WORKTREE_INVALID",
              "stored session mode is not write_worktree",
              { session_id: input.session_id, stored_mode: stored.mode },
            );
          }
          if (input.mode && input.mode !== stored.mode) {
            throw new GrokMcpError(
              "GROK_MCP_WORKTREE_INVALID",
              "caller mode does not match stored session mode",
              {
                session_id: input.session_id,
                mode: input.mode,
                stored_mode: stored.mode,
              },
            );
          }
          if (!stored.managed) {
            throw new GrokMcpError(
              "GROK_MCP_WORKTREE_INVALID",
              "write_worktree continue requires a server-managed session worktree",
              { session_id: input.session_id },
            );
          }
          if (!stored.worktree_path) {
            if (input.allow_missing_worktree && input.mode !== "write_worktree") {
              mode = "read_only";
              worktreePath = undefined;
              warnings.push("MODE_DOWNGRADED_MISSING_WORKTREE");
            } else {
              throw new GrokMcpError(
                "GROK_MCP_WORKTREE_MISSING",
                "Session worktree path is missing; refusing write_worktree continue against original tree",
                { session_id: input.session_id, worktree_path: null },
              );
            }
          }
        }

        if (mode === "write_worktree") {
          // Re-check after possible downgrade above
          const storedPath = stored!.worktree_path!;
          const exists = await pathExists(storedPath);
          const callerExists = input.worktree_path
            ? await pathExists(input.worktree_path)
            : true;

          if (!exists || !callerExists) {
            if (input.allow_missing_worktree && input.mode !== "write_worktree") {
              mode = "read_only";
              worktreePath = undefined;
              warnings.push("MODE_DOWNGRADED_MISSING_WORKTREE");
            } else {
              throw new GrokMcpError(
                "GROK_MCP_WORKTREE_MISSING",
                "Session worktree path is missing; refusing write_worktree continue against original tree",
                {
                  session_id: input.session_id,
                  worktree_path: worktreePath ?? null,
                },
              );
            }
          }
        }

        if (mode === "write_worktree") {
          // Full path/mode/repo/registration guards for write continue
          const storedReal = await resolveWorktreeRealpath(stored!.worktree_path!);
          let candidateReal = storedReal;
          if (input.worktree_path) {
            candidateReal = await resolveWorktreeRealpath(input.worktree_path);
            if (
              normalizeForCompare(candidateReal) !==
              normalizeForCompare(storedReal)
            ) {
              throw new GrokMcpError(
                "GROK_MCP_WORKTREE_INVALID",
                "caller worktree_path does not match stored session worktree_path",
                {
                  session_id: input.session_id,
                  worktree_path: candidateReal,
                  stored_worktree_path: storedReal,
                },
              );
            }
          }

          const resolvedWd = await resolveWorkingDirectory(
            input.working_directory,
            ctx.config.allowedRoots,
          );
          const repoRoot = await getRepoRoot(resolvedWd.realpath);
          let storedRepoReal: string;
          try {
            storedRepoReal = await fs.realpath(stored!.repo_root);
          } catch {
            storedRepoReal = stored!.repo_root;
          }
          let currentRepoReal: string;
          try {
            currentRepoReal = await fs.realpath(repoRoot);
          } catch {
            currentRepoReal = repoRoot;
          }
          if (
            normalizeForCompare(storedRepoReal) !==
            normalizeForCompare(currentRepoReal)
          ) {
            throw new GrokMcpError(
              "GROK_MCP_WORKTREE_INVALID",
              "stored session repo_root does not match working_directory repository",
              {
                session_id: input.session_id,
                repo_root: currentRepoReal,
                stored_repo_root: storedRepoReal,
              },
            );
          }

          worktreePath = await assertServerManagedWorktree({
            worktreePath: candidateReal,
            repoRoot: currentRepoReal,
            worktreesRoot: ctx.config.worktreesRoot,
            alreadyResolved: true,
          });
        }

        const result = await runTool(ctx, {
          tool: "grok_continue",
          prompt: input.prompt,
          workingDirectory: input.working_directory,
          mode,
          timeoutMs: input.timeout_ms,
          model: input.model,
          maxTurns: input.max_turns,
          reasoningEffort: input.reasoning_effort,
          testCommand: input.test_command,
          testTimeoutMs: input.test_timeout_ms,
          failOnTestFailure: input.fail_on_test_failure,
          includeThoughts: input.include_thoughts,
          verbatim: input.verbatim,
          rules: input.rules,
          tools: input.tools,
          disallowedTools: input.disallowed_tools,
          permissionMode: input.permission_mode,
          sandbox: input.sandbox,
          allowWeb: input.allow_web,
          allowSubagents: input.allow_subagents,
          // Per-call: never inherited from the resumed session record.
          responseMode: input.response_mode,
          keepWorktree: input.keep_worktree,
          resumeSessionId: input.session_id,
          worktreePathOverride: worktreePath,
          restoreCode: input.restore_code,
          signal: extra.signal,
        });

        if (warnings.length) {
          result.warnings = [...new Set([...warnings, ...result.warnings])];
        }

        const text = JSON.stringify(result, null, 2);
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const e = toolErrorToMcp(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: e.text }],
        };
      }
    },
  );
}
