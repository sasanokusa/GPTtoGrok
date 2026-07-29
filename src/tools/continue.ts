import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GrokMcpError } from "../errors.js";
import { ContinueInputSchema } from "../types.js";
import type { ToolContext } from "./common.js";
import { runTool, toolErrorToMcp } from "./common.js";
import { pathExists } from "../worktree.js";

export function registerContinue(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "grok_continue",
    {
      title: "Grok Continue (resume session)",
      description:
        "Resume a prior Grok session via --resume <session_id>. Pass the exact session_id from a previous result. Never creates a new worktree (-w). If prior mode was write_worktree and worktree is missing, fails closed unless allow_missing_worktree downgrades to read_only (cannot combine with mode=write_worktree).",
      inputSchema: ContinueInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        const input = ContinueInputSchema.parse(args);

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
          const exists = worktreePath ? await pathExists(worktreePath) : false;
          if (!exists) {
            if (input.allow_missing_worktree && input.mode !== "write_worktree") {
              mode = "read_only";
              worktreePath = undefined;
              warnings.push("MODE_DOWNGRADED_MISSING_WORKTREE");
            } else {
              throw new GrokMcpError(
                "GROK_MCP_WORKTREE_MISSING",
                "Session worktree path is missing; refusing write_worktree continue against original tree",
                { session_id: input.session_id, worktree_path: worktreePath ?? null },
              );
            }
          }
        }

        if (!stored && !input.allow_unmapped_session && mode === "write_worktree" && !worktreePath) {
          throw new GrokMcpError(
            "GROK_MCP_SESSION_NOT_FOUND",
            "Session not in MCP store and no worktree_path provided",
            { session_id: input.session_id },
          );
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
