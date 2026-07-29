#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { setLogLevel, type LogLevel, logger } from "./log.js";
import { startStdioServer } from "./server.js";

async function main(): Promise<void> {
  const level = (process.env.GROK_MCP_LOG_LEVEL as LogLevel) || "info";
  setLogLevel(level);
  const config = loadConfig();
  await startStdioServer(config);
}

main().catch((err) => {
  logger.error("Fatal error", { err: String(err) });
  process.exit(1);
});
