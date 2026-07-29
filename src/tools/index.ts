import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./common.js";
import { registerAnalyze } from "./analyze.js";
import { registerContinue } from "./continue.js";
import { registerDebug } from "./debug.js";
import { registerImplement } from "./implement.js";
import { registerReview } from "./review.js";

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerAnalyze(server, ctx);
  registerImplement(server, ctx);
  registerReview(server, ctx);
  registerDebug(server, ctx);
  registerContinue(server, ctx);
}

export type { ToolContext } from "./common.js";
