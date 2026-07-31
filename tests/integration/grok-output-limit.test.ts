import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../../src/config.js";
import { GrokMcpError } from "../../src/errors.js";
import { GrokRunner, mapRunOutcomeToError } from "../../src/grok-runner.js";
import { SessionStore } from "../../src/session-store.js";
import { DEFAULT_DISALLOWED_TOOLS, READ_ONLY_TOOLS } from "../../src/tool-ids.js";
import { runTool, type ToolContext } from "../../src/tools/common.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function writeMockGrok(): string {
  const dir = tmp("cgm-output-limit-");
  const bin = path.join(dir, "mock-grok");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type: "text", data: "x".repeat(20000)}) + "\\n");\nsetTimeout(() => {}, 30000);\n`,
    { mode: 0o755 },
  );
  return bin;
}

/**
 * Mock that emits a large streaming-json text payload (over the stdout cap)
 * AND mutates the worktree so assembleDiff would have a non-empty partial
 * diff — the exact soft-degrade path that used to swallow OUTPUT_TOO_LARGE.
 */
function writeMockGrokWithWorktreeEdit(): string {
  const dir = tmp("cgm-output-limit-edit-");
  const bin = path.join(dir, "mock-grok");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
// Partial useful text + a real file edit so hasUseful would be true.
process.stdout.write(JSON.stringify({type: "text", data: "partial work " + "y".repeat(5000)}) + "\\n");
try {
  fs.writeFileSync(path.join(process.cwd(), "partial-edit.txt"), "edited by mock\\n");
} catch { /* ignore */ }
process.stdout.write(JSON.stringify({type: "text", data: "x".repeat(20000)}) + "\\n");
setTimeout(() => {}, 30000);
`,
    { mode: 0o755 },
  );
  return bin;
}

function initRepo(): string {
  const d = tmp("cgm-output-limit-repo-");
  execFileSync("git", ["init"], { cwd: d });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: d });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: d });
  fs.writeFileSync(path.join(d, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "-A"], { cwd: d });
  execFileSync("git", ["commit", "-m", "init"], { cwd: d });
  return d;
}

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const cacheDir = overrides.cacheDir ?? tmp("cgm-output-limit-cache-");
  return {
    grokBin: "unset",
    allowedRoots: [fs.realpathSync(os.tmpdir())],
    maxConcurrent: 2,
    maxQueue: 8,
    worktreeTtlHours: 72,
    maxSessions: 500,
    sandboxWrite: "workspace",
    sandboxReadOnly: null,
    useGrokWorktree: false,
    failOnOriginalDirty: false,
    defaultReadOnlyTools: [...READ_ONLY_TOOLS],
    defaultDisallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
    secretBasenames: [],
    secretGlobsAggressive: false,
    maxTimeoutMs: 3_600_000,
    maxDiffBytes: 0,
    maxSummaryBytes: 512_000,
    maxPromptDiffBytes: 262_144,
    maxUntrackedFileBytes: 524_288,
    maxStderrBytes: 64_000,
    maxStdoutBytes: 1024,
    maxTestOutputBytes: 65_536,
    maxTestOutputSuccessBytes: 4_096,
    inlineDiffMaxBytes: 65_536,
    inlineDiffHardMaxBytes: 1_048_576,
    cacheDir,
    sessionStorePath: path.join(cacheDir, "sessions.json"),
    worktreesRoot: path.join(cacheDir, "worktrees"),
    ...overrides,
  };
}

describe("GrokRunner stdout limit", () => {
  it("kills the process group and reports a structured output-limit error", async () => {
    const runner = new GrokRunner(1, 1, 1024);
    const outcome = await runner.run({
      grokBin: writeMockGrok(),
      argv: [],
      spawnCwd: os.tmpdir(),
      timeoutMs: 10_000,
      maxStderrBytes: 1000,
    });

    expect(outcome.outputLimitExceeded).toBe(true);
    expect(outcome.stdoutBytes).toBeGreaterThan(1024);
    expect(Buffer.byteLength(outcome.parse.text, "utf8")).toBeLessThanOrEqual(1024);

    const error = mapRunOutcomeToError(outcome);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("GROK_MCP_OUTPUT_TOO_LARGE");
    expect(error?.details).toMatchObject({
      max_stdout_bytes: 1024,
      warnings: ["PARTIAL_RESULT", "OUTPUT_LIMIT_EXCEEDED"],
    });
  });
});

describe("runTool OUTPUT_TOO_LARGE hard error", () => {
  it("surfaces GROK_MCP_OUTPUT_TOO_LARGE even when partial text and a worktree diff exist", async () => {
    const repo = initRepo();
    const config = makeConfig({
      grokBin: writeMockGrokWithWorktreeEdit(),
      maxStdoutBytes: 1024,
    });
    const ctx: ToolContext = {
      config,
      runner: new GrokRunner(config.maxConcurrent, config.maxQueue, config.maxStdoutBytes),
      store: new SessionStore(config.sessionStorePath, config.maxSessions, {
        maxTimeoutMs: config.maxTimeoutMs,
      }),
    };

    let caught: unknown;
    try {
      await runTool(ctx, {
        tool: "grok_implement",
        prompt: "make a change",
        workingDirectory: repo,
        mode: "write_worktree",
        keepWorktree: true,
        responseMode: "full",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GrokMcpError);
    const error = caught as GrokMcpError;
    expect(error.code).toBe("GROK_MCP_OUTPUT_TOO_LARGE");
    expect(error.details?.warnings).toEqual(
      expect.arrayContaining(["PARTIAL_RESULT", "OUTPUT_LIMIT_EXCEEDED"]),
    );
    expect(error.details?.max_stdout_bytes).toBe(1024);
    // Mapped details preserved (partial_summary / stdout_bytes).
    expect(typeof error.details?.stdout_bytes).toBe("number");
    expect(Number(error.details?.stdout_bytes)).toBeGreaterThan(1024);
    // Must not soft-degrade to a success result with GROK_NONZERO_EXIT.
    expect(error.details?.warnings).not.toEqual(
      expect.arrayContaining(["GROK_NONZERO_EXIT"]),
    );
  });
});
