import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ImplementInputSchema } from "../types.js";
import type { ToolContext } from "./common.js";
import { parseToolInput, runTool, toolErrorToMcp } from "./common.js";

export function registerImplement(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "grok_implement",
    {
      title: "Grok Implement (isolated worktree)",
      description:
        "Implement a feature or fix via Grok Build in an isolated git worktree (does not edit the original tree by default). Returns worktree_path, diff, and changed_files for Codex to apply. Requires absolute working_directory and a git repo. Set Codex tool_timeout_sec=2400.",
      inputSchema: ImplementInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        const input = parseToolInput(ImplementInputSchema, args);
        const result = await runTool(ctx, {
          tool: "grok_implement",
          prompt: input.prompt,
          workingDirectory: input.working_directory,
          mode: "write_worktree",
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
