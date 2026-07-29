import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISALLOWED_TOOLS,
  READ_ONLY_TOOLS,
} from "../../src/tool-ids.js";
import { buildGrokArgv } from "../../src/grok-runner.js";

describe("tool-ids and argv", () => {
  it("denylist includes both shell tool IDs and Agent", () => {
    expect(DEFAULT_DISALLOWED_TOOLS).toContain("run_terminal_cmd");
    expect(DEFAULT_DISALLOWED_TOOLS).toContain("run_terminal_command");
    expect(DEFAULT_DISALLOWED_TOOLS).toContain("Agent");
  });

  it("read-only allowlist is exploration tools only", () => {
    expect(READ_ONLY_TOOLS).toEqual(["read_file", "grep", "list_dir"]);
  });

  it("buildGrokArgv always includes required headless flags", () => {
    const argv = buildGrokArgv({
      prompt: "hi",
      cwd: "/tmp/proj",
      alwaysApprove: true,
    });
    expect(argv).toContain("--no-auto-update");
    expect(argv).toContain("-p");
    expect(argv).toContain("hi");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("streaming-json");
    expect(argv).toContain("--cwd");
    expect(argv).toContain("/tmp/proj");
    expect(argv).toContain("--always-approve");
  });

  it("does not pass -w when resume is set", () => {
    const argv = buildGrokArgv({
      prompt: "more",
      cwd: "/wt",
      resumeSessionId: "sess-1",
      useGrokWorktree: true,
      worktreeName: "should-not-appear",
    });
    expect(argv).toContain("-r");
    expect(argv).toContain("sess-1");
    expect(argv).not.toContain("-w");
  });

  it("includes both shell IDs in disallowed-tools", () => {
    const argv = buildGrokArgv({
      prompt: "x",
      cwd: "/tmp",
      tools: ["read_file", "grep", "list_dir"],
      disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
      noSubagents: true,
    });
    const idx = argv.indexOf("--disallowed-tools");
    expect(idx).toBeGreaterThan(-1);
    const list = argv[idx + 1]!;
    expect(list).toContain("run_terminal_cmd");
    expect(list).toContain("run_terminal_command");
    expect(list).toContain("Agent");
    expect(argv).toContain("--no-subagents");
  });
});
