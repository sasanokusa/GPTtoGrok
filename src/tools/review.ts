import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDiffVsRef } from "../git.js";
import { ReviewInputSchema } from "../types.js";
import type { ToolContext } from "./common.js";
import { runTool, toolErrorToMcp } from "./common.js";

export function registerReview(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "grok_review",
    {
      title: "Grok Review (read-only by default)",
      description:
        "Code review via Grok Build. By default injects a redacted git diff vs base_ref (default HEAD) into the prompt. read_only by default. Requires absolute working_directory.",
      inputSchema: ReviewInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        const input = ReviewInputSchema.parse(args);
        let prompt = input.prompt;
        if (input.inject_diff !== false) {
          try {
            const baseRef = input.base_ref || "HEAD";
            const d = await getDiffVsRef(
              input.working_directory,
              baseRef,
              ctx.config.maxPromptDiffBytes,
              {
                secretBasenames: ctx.config.secretBasenames,
                aggressive: ctx.config.secretGlobsAggressive,
              },
            );
            const body = d.empty
              ? `(no diff vs ${baseRef})`
              : `### stat\n${d.stat}\n\n### diff\n${d.diff}`;
            prompt = `${input.prompt}\n\n## Diff vs ${baseRef} (server-injected, may be truncated)\n${body}`;
          } catch {
            prompt = `${input.prompt}\n\n## Diff vs base_ref\n(failed to collect git diff; review from prompt context only)`;
          }
        }

        const result = await runTool(ctx, {
          tool: "grok_review",
          prompt,
          workingDirectory: input.working_directory,
          mode: input.mode ?? "read_only",
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
