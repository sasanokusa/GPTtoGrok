import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../../src/config.js";
import { GrokMcpError, isGrokMcpError } from "../../src/errors.js";
import { buildGrokArgv } from "../../src/grok-runner.js";
import {
  DEFAULT_DISALLOWED_TOOLS,
  READ_ONLY_TOOLS,
  narrowReadOnlyTools,
  unionDisallowedTools,
} from "../../src/tool-ids.js";
import { buildModeFlags } from "../../src/tools/common.js";
import { rejectTestCommandInReadOnly } from "../../src/types.js";

function minimalConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    grokBin: "grok",
    allowedRoots: ["/tmp"],
    maxConcurrent: 2,
    maxQueue: 8,
    worktreeTtlHours: 72,
    maxSessions: 500,
    sandboxWrite: "workspace",
    sandboxReadOnly: "read-only",
    useGrokWorktree: false,
    failOnOriginalDirty: false,
    defaultReadOnlyTools: [...READ_ONLY_TOOLS],
    defaultDisallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
    secretBasenames: [".env"],
    secretGlobsAggressive: false,
    maxTimeoutMs: 3_600_000,
    maxDiffBytes: 0,
    maxSummaryBytes: 512_000,
    maxPromptDiffBytes: 262_144,
    maxUntrackedFileBytes: 524_288,
    maxStderrBytes: 64_000,
    maxTestOutputBytes: 65_536,
    maxTestOutputSuccessBytes: 4_096,
    inlineDiffMaxBytes: 65_536,
    inlineDiffHardMaxBytes: 1_048_576,
    cacheDir: "/tmp/cache",
    sessionStorePath: "/tmp/cache/sessions.json",
    worktreesRoot: "/tmp/cache/worktrees",
    ...overrides,
  };
}

describe("buildGrokArgv reasoning effort", () => {
  it("passes --reasoning-effort high", () => {
    const argv = buildGrokArgv({
      prompt: "think hard",
      cwd: "/tmp/proj",
      reasoningEffort: "high",
      alwaysApprove: true,
    });
    const idx = argv.indexOf("--reasoning-effort");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("high");
  });
});

describe("narrowReadOnlyTools empty-array fail-closed", () => {
  it("keeps configured allowlist when caller passes empty array", () => {
    const result = narrowReadOnlyTools([...READ_ONLY_TOOLS], []);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toEqual([...READ_ONLY_TOOLS]);
  });

  it("falls back to READ_ONLY_TOOLS when configured allow is empty", () => {
    const result = narrowReadOnlyTools([], undefined);
    expect(result).toEqual([...READ_ONLY_TOOLS]);
    expect(result.length).toBeGreaterThan(0);
  });

  it("falls back when intersection is empty (mutating tools only)", () => {
    const result = narrowReadOnlyTools([...READ_ONLY_TOOLS], [
      "write",
      "search_replace",
      "run_terminal_cmd",
    ]);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toEqual([...READ_ONLY_TOOLS]);
  });

  it("narrows to intersection of safe tools only", () => {
    const result = narrowReadOnlyTools([...READ_ONLY_TOOLS], [
      "read_file",
      "write",
      "grep",
    ]);
    expect(result).toEqual(["read_file", "grep"]);
  });
});

describe("buildModeFlags fail-closed read_only", () => {
  const cfg = minimalConfig();

  it("drops mutating caller tools from the allowlist", () => {
    const flags = buildModeFlags("read_only", cfg, {
      tools: ["read_file", "write", "search_replace", "run_terminal_command"],
    });
    expect(flags.tools).toEqual(["read_file"]);
    expect(flags.tools).not.toContain("write");
    expect(flags.tools).not.toContain("search_replace");
    expect(flags.tools).not.toContain("run_terminal_command");
  });

  it("always includes mandatory deny IDs even if caller tries to clear them", () => {
    // Caller omits denylist entirely or only adds unrelated tools — mandatory stays.
    const flagsEmpty = buildModeFlags("read_only", cfg, {
      disallowedTools: [],
    });
    for (const id of DEFAULT_DISALLOWED_TOOLS) {
      expect(flagsEmpty.disallowedTools).toContain(id);
    }

    // Caller cannot "remove" by only listing a subset — union still has mandatory.
    const flagsPartial = buildModeFlags("read_only", cfg, {
      disallowedTools: ["web_search"],
    });
    expect(flagsPartial.disallowedTools).toContain("run_terminal_cmd");
    expect(flagsPartial.disallowedTools).toContain("run_terminal_command");
    expect(flagsPartial.disallowedTools).toContain("Agent");
    expect(flagsPartial.disallowedTools).toContain("search_replace");
    expect(flagsPartial.disallowedTools).toContain("write");
    expect(flagsPartial.disallowedTools).toContain("web_search");
  });

  it("unionDisallowedTools never drops mandatory IDs", () => {
    const out = unionDisallowedTools([], []);
    for (const id of DEFAULT_DISALLOWED_TOOLS) {
      expect(out).toContain(id);
    }
  });

  it("always disables subagents even when allowSubagents is true", () => {
    const flags = buildModeFlags("read_only", cfg, {
      allowSubagents: true,
    });
    expect(flags.noSubagents).toBe(true);
  });

  it("rejects unsafe read_only permission modes", () => {
    for (const permissionMode of [
      "bypassPermissions",
      "acceptEdits",
      "auto",
      "default",
    ] as const) {
      expect(() =>
        buildModeFlags("read_only", cfg, { permissionMode }),
      ).toThrow(GrokMcpError);
      try {
        buildModeFlags("read_only", cfg, { permissionMode });
      } catch (err) {
        expect(isGrokMcpError(err)).toBe(true);
        if (isGrokMcpError(err)) {
          expect(err.code).toBe("GROK_MCP_INVALID_ARGS");
          expect(err.message).toContain(permissionMode);
        }
      }
    }
  });

  it("rejects unsafe read_only sandboxes", () => {
    for (const sandbox of ["off", "workspace"] as const) {
      expect(() => buildModeFlags("read_only", cfg, { sandbox })).toThrow(
        GrokMcpError,
      );
      try {
        buildModeFlags("read_only", cfg, { sandbox });
      } catch (err) {
        expect(isGrokMcpError(err)).toBe(true);
        if (isGrokMcpError(err)) {
          expect(err.code).toBe("GROK_MCP_INVALID_ARGS");
          expect(err.message).toContain(sandbox);
        }
      }
    }
  });

  it("forces dontAsk permission and default read-only sandbox", () => {
    const flags = buildModeFlags("read_only", cfg, {});
    expect(flags.permissionMode).toBe("dontAsk");
    expect(flags.alwaysApprove).toBe(false);
    expect(flags.sandbox).toBe("read-only");
  });
});

describe("rejectTestCommandInReadOnly", () => {
  it("rejects test_command in read_only mode", () => {
    expect(() =>
      rejectTestCommandInReadOnly("read_only", "npm test"),
    ).toThrow(GrokMcpError);
    try {
      rejectTestCommandInReadOnly("read_only", "npm test");
    } catch (err) {
      expect(isGrokMcpError(err)).toBe(true);
      if (isGrokMcpError(err)) {
        expect(err.code).toBe("GROK_MCP_INVALID_ARGS");
        expect(err.message).toMatch(/test_command/i);
      }
    }
  });

  it("allows test_command in write_worktree mode", () => {
    expect(() =>
      rejectTestCommandInReadOnly("write_worktree", "npm test"),
    ).not.toThrow();
  });

  it("allows missing test_command in either mode", () => {
    expect(() =>
      rejectTestCommandInReadOnly("read_only", undefined),
    ).not.toThrow();
    expect(() =>
      rejectTestCommandInReadOnly("write_worktree", undefined),
    ).not.toThrow();
  });
});
