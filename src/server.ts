import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServerConfig } from "./config.js";
import { gcDiffArtifacts } from "./diff-artifact.js";
import { GrokRunner } from "./grok-runner.js";
import { logger } from "./log.js";
import { SessionStore } from "./session-store.js";
import { registerAllTools } from "./tools/index.js";
import { removeWorktree } from "./worktree.js";

const INSTRUCTIONS = `
Delegates coding work to local Grok Build CLI (headless):
  grok --no-auto-update -p <prompt> --output-format streaming-json

REQUIREMENTS:
- Always pass absolute working_directory.
- Codex config MUST set tool_timeout_sec >= 2400 for this server (host defaults ~60s are too short).
- Also set startup_timeout_sec = 30.
- write tools (implement/debug) edit an isolated git worktree, NOT the original tree (best-effort isolation).
- Apply results using worktree_path + diff + changed_files; do not assume the primary tree changed.
- Continue with grok_continue + session_id from prior results (opaque id; prefer exact UUID from result).
- read_only tools must not modify files; report UNEXPECTED_MUTATION warnings if they do.
- Never put secrets (.env, private keys, auth files) into prompts.

RESPONSE SIZE:
- Optional response_mode: auto (default) | full | compact | summary_only.
- auto inlines the diff up to GROK_MCP_INLINE_DIFF_MAX_BYTES (64 KiB), else compact.
- If diff_included is false, the diff field is "": read diff_artifact_path (compact)
  or inspect changed_files under worktree_path, and follow next_actions.
- diff_bytes / diff_sha256 / diff_stats are always returned and describe the redacted patch.

Tools:
- grok_analyze — read-only analysis
- grok_implement — implement in isolated worktree
- grok_review — review (injects git diff vs base_ref)
- grok_debug — debug/fix in worktree (or read_only)
- grok_continue — resume session via --resume
`.trim();

export function createServer(config: ServerConfig): McpServer {
  const server = new McpServer(
    {
      name: "codex-grok-mcp",
      version: "0.1.0",
    },
    {
      instructions: INSTRUCTIONS,
    },
  );

  const runner = new GrokRunner(
    config.maxConcurrent,
    config.maxQueue,
    config.maxStdoutBytes,
  );
  const store = new SessionStore(config.sessionStorePath, config.maxSessions);

  registerAllTools(server, { config, runner, store });

  void store
    .gc(config.worktreeTtlHours, async (entry) => {
      const wtPath =
        "worktree_path" in entry && entry.worktree_path
          ? entry.worktree_path
          : undefined;
      const repo =
        "repo_root" in entry && entry.repo_root ? entry.repo_root : undefined;
      if (!wtPath || !repo) return true;

      const isSession =
        "session_id" in entry ||
        ("managed" in entry && !("run_id" in entry));
      if (isSession) {
        const managed =
          "managed" in entry ? (entry as { managed?: boolean }).managed : undefined;
        if (managed !== true) {
          logger.warn("Refusing GC of non-managed session worktree", {
            worktree_path: wtPath,
            repo_root: repo,
          });
          return true;
        }
      }

      return removeWorktree(repo, wtPath, config.worktreesRoot);
    })
    .then((n) => {
      if (n > 0) logger.info("GC removed stale worktrees", { count: n });
    })
    .catch((err) => logger.warn("GC failed", { err: String(err) }));

  void gcDiffArtifacts(config.cacheDir, config.worktreeTtlHours)
    .then((n) => {
      if (n > 0) logger.info("GC removed stale diff artifacts", { count: n });
    })
    .catch((err) => logger.warn("Diff artifact GC failed", { err: String(err) }));

  return server;
}

export async function startStdioServer(config: ServerConfig): Promise<void> {
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("codex-grok-mcp listening on stdio", {
    grokBin: config.grokBin,
    maxConcurrent: config.maxConcurrent,
  });
}
