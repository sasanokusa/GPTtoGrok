import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DebugInputSchema } from "../types.js";
import type { ToolContext } from "./common.js";
import { runTool, toolErrorToMcp } from "./common.js";

export function registerDebug(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "grok_debug",
    {
      title: "Grok Debug",
      description:
        "Debug and optionally fix issues via Grok Build. Defaults to write_worktree (isolated). Can pass mode=read_only for diagnosis only. Returns worktree_path/diff when writing. Absolute working_directory required.",
      inputSchema: DebugInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        const input = DebugInputSchema.parse(args);
        const result = await runTool(ctx, {
          tool: "grok_debug",
          prompt: input.prompt,
          workingDirectory: input.working_directory,
          mode: input.mode ?? "write_worktree",
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
          worktreeRef: input.worktree_ref,
          worktreeName: input.worktree_name,
          keepWorktree: input.keep_worktree,
          useGrokWorktree: input.use_grok_worktree,
          signal: extra.signal,
        });
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
