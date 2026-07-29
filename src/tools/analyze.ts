import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BaseToolInputSchema } from "../types.js";
import type { ToolContext } from "./common.js";
import { runTool, toolErrorToMcp } from "./common.js";

export function registerAnalyze(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "grok_analyze",
    {
      title: "Grok Analyze (read-only)",
      description:
        "Read-only codebase analysis via Grok Build headless CLI. Does not create a worktree. Requires absolute working_directory. Codex must set tool_timeout_sec >= 2400 on this MCP server.",
      inputSchema: BaseToolInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        const input = BaseToolInputSchema.parse(args);
        const result = await runTool(ctx, {
          tool: "grok_analyze",
          prompt: input.prompt,
          workingDirectory: input.working_directory,
          mode: "read_only",
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
