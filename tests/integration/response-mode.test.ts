/**
 * End-to-end response_mode behaviour through `runTool` with a mock Grok binary.
 * Covers auto/full/compact/summary_only, artifact contents and safety, secret
 * redaction into artifacts, continue, and the artifact-failure degradation path.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../../src/config.js";
import { diffArtifactsRoot } from "../../src/diff-artifact.js";
import { GrokRunner } from "../../src/grok-runner.js";
import { SessionStore } from "../../src/session-store.js";
import { DEFAULT_DISALLOWED_TOOLS, READ_ONLY_TOOLS } from "../../src/tool-ids.js";
import { runTool, type ToolContext } from "../../src/tools/common.js";
import type { ResponseMode } from "../../src/types.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function initRepo(): string {
  const d = tmp("cgm-rm-repo-");
  execFileSync("git", ["init"], { cwd: d });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: d });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: d });
  fs.writeFileSync(path.join(d, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "-A"], { cwd: d });
  execFileSync("git", ["commit", "-m", "init"], { cwd: d });
  return d;
}

function writeMockGrok(body: string): string {
  const dir = tmp("cgm-rm-bin-");
  const bin = path.join(dir, "mock-grok");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
set -e
echo '{"type":"text","data":"mock grok did the work"}'
${body}
echo '{"type":"end","sessionId":"mock-session-id","stopReason":"EndTurn"}'
exit 0
`,
    { mode: 0o755 },
  );
  return bin;
}

/** Mock that appends `lines` lines to `out.txt` inside its cwd (the worktree). */
function mockWritingLines(lines: number, file = "out.txt"): string {
  return writeMockGrok(
    `i=0
while [ $i -lt ${lines} ]; do
  echo "generated content line $i padded to make this diff large enough xxxxxxxxxxxxxxxx" >> "${file}"
  i=$((i+1))
done`,
  );
}

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const cacheDir = overrides.cacheDir ?? tmp("cgm-rm-cache-");
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
    maxDiffBytes: 1_048_576,
    maxSummaryBytes: 512_000,
    maxPromptDiffBytes: 262_144,
    maxUntrackedFileBytes: 524_288,
    maxStderrBytes: 64_000,
    inlineDiffMaxBytes: 65_536,
    inlineDiffHardMaxBytes: 1_048_576,
    cacheDir,
    sessionStorePath: path.join(cacheDir, "sessions.json"),
    worktreesRoot: path.join(cacheDir, "worktrees"),
    ...overrides,
  };
}

function makeCtx(config: ServerConfig): ToolContext {
  return {
    config,
    runner: new GrokRunner(config.maxConcurrent, config.maxQueue),
    store: new SessionStore(config.sessionStorePath, config.maxSessions),
  };
}

async function implement(opts: {
  ctx: ToolContext;
  repo: string;
  grokBin: string;
  responseMode?: ResponseMode;
}) {
  return runTool(
    { ...opts.ctx, config: { ...opts.ctx.config, grokBin: opts.grokBin } },
    {
      tool: "grok_implement",
      prompt: "make a change",
      workingDirectory: opts.repo,
      mode: "write_worktree",
      keepWorktree: true,
      responseMode: opts.responseMode,
    },
  );
}

const SHA256_EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("response_mode end-to-end", () => {
  it("auto + small diff → full, diff inlined, no artifact", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const r = await implement({
      ctx,
      repo,
      grokBin: mockWritingLines(3),
      responseMode: "auto",
    });

    expect(r.result_version).toBe(1);
    expect(r.response_mode_requested).toBe("auto");
    expect(r.response_mode_effective).toBe("full");
    expect(r.diff_included).toBe(true);
    expect(r.diff).toContain("generated content line 0");
    expect(r.diff_artifact_path).toBeNull();
    expect(r.diff_bytes).toBeLessThanOrEqual(65_536);
    expect(r.diff_bytes).toBe(Buffer.byteLength(r.diff, "utf8"));
    expect(r.diff_stats.files_changed).toBe(1);
    expect(r.diff_stats.insertions).toBe(3);
    expect(r.warnings).not.toContain("DIFF_NOT_INLINED");
    expect(r.next_actions).toEqual([]);
  });

  it("auto + large diff → compact, no diff body, artifact created", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const r = await implement({
      ctx,
      repo,
      grokBin: mockWritingLines(1200),
      responseMode: "auto",
    });

    expect(r.diff_bytes).toBeGreaterThan(65_536);
    expect(r.response_mode_requested).toBe("auto");
    expect(r.response_mode_effective).toBe("compact");
    expect(r.diff_included).toBe(false);
    expect(r.diff).toBe("");
    expect(r.diff_artifact_path).toBeTruthy();
    expect(r.warnings).toContain("DIFF_NOT_INLINED");
    expect(r.warnings).toContain("DIFF_ARTIFACT_CREATED");
    expect(r.next_actions.length).toBeGreaterThan(0);

    // compact still carries everything needed to act
    expect(r.summary).toContain("mock grok");
    expect(r.changed_files).toContain("out.txt");
    expect(r.session_id).toBe("mock-session-id");
    expect(r.worktree_path).toBeTruthy();
    expect(r.tests).toEqual({ ran: false });
  });

  it("compact artifact matches diff_sha256 and diff_bytes exactly", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const r = await implement({
      ctx,
      repo,
      grokBin: mockWritingLines(1200),
      responseMode: "compact",
    });

    const stored = fs.readFileSync(r.diff_artifact_path!, "utf8");
    const digest = crypto.createHash("sha256").update(stored, "utf8").digest("hex");
    expect(digest).toBe(r.diff_sha256);
    expect(Buffer.byteLength(stored, "utf8")).toBe(r.diff_bytes);
    expect(fs.statSync(r.diff_artifact_path!).size).toBe(r.diff_bytes);
  });

  it("full inlines a diff that auto would have compacted", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const r = await implement({
      ctx,
      repo,
      grokBin: mockWritingLines(1200),
      responseMode: "full",
    });

    expect(r.response_mode_effective).toBe("full");
    expect(r.diff_included).toBe(true);
    expect(r.diff_bytes).toBeGreaterThan(65_536);
    expect(Buffer.byteLength(r.diff, "utf8")).toBe(r.diff_bytes);
    expect(
      crypto.createHash("sha256").update(r.diff, "utf8").digest("hex"),
    ).toBe(r.diff_sha256);
    expect(r.diff_artifact_path).toBeNull();
    expect(fs.existsSync(diffArtifactsRoot(ctx.config.cacheDir))).toBe(false);
  });

  it("full past the hard cap degrades to compact instead of truncating silently", async () => {
    const repo = initRepo();
    const ctx = makeCtx(
      makeConfig({ inlineDiffMaxBytes: 1024, inlineDiffHardMaxBytes: 4096 }),
    );
    const r = await implement({
      ctx,
      repo,
      grokBin: mockWritingLines(600),
      responseMode: "full",
    });

    expect(r.diff_bytes).toBeGreaterThan(4096);
    expect(r.response_mode_requested).toBe("full");
    expect(r.response_mode_effective).toBe("compact");
    expect(r.diff).toBe("");
    expect(r.warnings).toContain("DIFF_HARD_LIMIT_APPLIED");
    expect(r.diff_artifact_path).toBeTruthy();
    // The stored artifact is the complete patch — nothing was cut.
    expect(Buffer.byteLength(fs.readFileSync(r.diff_artifact_path!, "utf8"), "utf8"))
      .toBe(r.diff_bytes);
  });

  it("summary_only returns neither a diff body nor an artifact", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const r = await implement({
      ctx,
      repo,
      grokBin: mockWritingLines(1200),
      responseMode: "summary_only",
    });

    expect(r.response_mode_effective).toBe("summary_only");
    expect(r.diff_included).toBe(false);
    expect(r.diff).toBe("");
    expect(r.diff_artifact_path).toBeNull();
    expect(fs.existsSync(diffArtifactsRoot(ctx.config.cacheDir))).toBe(false);

    // Still enough to inspect the change in the worktree.
    expect(r.changed_files).toContain("out.txt");
    expect(r.worktree_path).toBeTruthy();
    expect(fs.existsSync(path.join(r.worktree_path!, "out.txt"))).toBe(true);
    expect(r.diff_bytes).toBeGreaterThan(0);
    expect(r.diff_sha256).not.toBe(SHA256_EMPTY);
    expect(r.diff_stats.files_changed).toBe(1);
  });

  it("reports a consistent zero shape when nothing changed", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const r = await implement({
      ctx,
      repo,
      grokBin: writeMockGrok("true"),
      responseMode: "auto",
    });

    expect(r.response_mode_effective).toBe("full");
    expect(r.diff).toBe("");
    expect(r.diff_bytes).toBe(0);
    expect(r.diff_sha256).toBe(SHA256_EMPTY);
    expect(r.diff_stats).toEqual({
      files_changed: 0,
      insertions: 0,
      deletions: 0,
    });
    expect(r.diff_artifact_path).toBeNull();
    expect(r.warnings).not.toContain("DIFF_NOT_INLINED");
  });

  it("compact with an empty diff writes no artifact", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const r = await implement({
      ctx,
      repo,
      grokBin: writeMockGrok("true"),
      responseMode: "compact",
    });

    expect(r.response_mode_effective).toBe("compact");
    expect(r.diff_artifact_path).toBeNull();
    expect(r.warnings).not.toContain("DIFF_ARTIFACT_CREATED");
    expect(fs.existsSync(diffArtifactsRoot(ctx.config.cacheDir))).toBe(false);
  });

  it("omitting response_mode behaves exactly like auto (existing callers)", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const r = await implement({ ctx, repo, grokBin: mockWritingLines(3) });

    expect(r.response_mode_requested).toBe("auto");
    expect(r.response_mode_effective).toBe("full");
    expect(r.diff).toContain("generated content line 0");
    expect(r.result_version).toBe(1);
  });
});

describe("secret redaction is preserved in artifacts", () => {
  it("secret paths never reach the compact artifact", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const bin = writeMockGrok(
      `printf 'XAI_API_KEY=sk-ABCDEFGHIJKLMNOPQRSTUVWX\\n' > .env
printf 'BEGIN\\n' > id_rsa
i=0
while [ $i -lt 1200 ]; do
  echo "ordinary padding line $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" >> app.ts
  i=$((i+1))
done`,
    );
    const r = await implement({ ctx, repo, grokBin: bin, responseMode: "compact" });

    const stored = fs.readFileSync(r.diff_artifact_path!, "utf8");
    expect(stored).not.toContain(".env");
    expect(stored).not.toContain("id_rsa");
    expect(stored).toContain("app.ts");
    expect(r.changed_files).not.toContain(".env");
    expect(r.changed_files).not.toContain("id_rsa");
    expect(r.warnings).toContain("REDACTED_SECRET_PATHS");
  });

  it("secret strings in ordinary files are redacted before the artifact is written", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const bin = writeMockGrok(
      `echo 'const token = "sk-ABCDEFGHIJKLMNOPQRSTUVWX";' >> config.ts
echo 'api_key = "supersecretvalue123"' >> config.ts
i=0
while [ $i -lt 1200 ]; do
  echo "ordinary padding line $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" >> config.ts
  i=$((i+1))
done`,
    );
    const r = await implement({ ctx, repo, grokBin: bin, responseMode: "compact" });

    const stored = fs.readFileSync(r.diff_artifact_path!, "utf8");
    expect(stored).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(stored).not.toContain("supersecretvalue123");
    expect(stored).toContain("[REDACTED]");
    // Hash and byte count describe the redacted body that was stored.
    expect(
      crypto.createHash("sha256").update(stored, "utf8").digest("hex"),
    ).toBe(r.diff_sha256);
  });

  it("artifacts stay inside the managed cache root", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const r = await implement({
      ctx,
      repo,
      grokBin: mockWritingLines(1200),
      responseMode: "compact",
    });

    const realCache = fs.realpathSync(ctx.config.cacheDir);
    const realRoot = fs.realpathSync(diffArtifactsRoot(ctx.config.cacheDir));
    expect(r.diff_artifact_path!.startsWith(realRoot + path.sep)).toBe(true);
    expect(r.diff_artifact_path!.startsWith(realCache + path.sep)).toBe(true);
    expect(r.diff_artifact_path).not.toContain("..");
    expect(path.basename(r.diff_artifact_path!)).toMatch(
      /^[0-9a-f-]{36}\.diff$/,
    );
  });
});

describe("unrecoverable combinations are flagged", () => {
  it("summary_only + keep_worktree=false warns DIFF_DISCARDED_NO_ARTIFACT", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const r = await runTool(
      { ...ctx, config: { ...ctx.config, grokBin: mockWritingLines(20) } },
      {
        tool: "grok_implement",
        prompt: "make a change",
        workingDirectory: repo,
        mode: "write_worktree",
        keepWorktree: false,
        responseMode: "summary_only",
      },
    );

    expect(r.warnings).toContain("DIFF_DISCARDED_NO_ARTIFACT");
    expect(r.next_actions[0]).toContain("response_mode");
    expect(r.next_actions.join(" ")).toContain("keep_worktree");
    // Stats and hash still describe what was produced.
    expect(r.diff_bytes).toBeGreaterThan(0);
    expect(r.diff_stats.insertions).toBe(20);
  });

  it("compact + keep_worktree=false is recoverable via the artifact", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const r = await runTool(
      { ...ctx, config: { ...ctx.config, grokBin: mockWritingLines(20) } },
      {
        tool: "grok_implement",
        prompt: "make a change",
        workingDirectory: repo,
        mode: "write_worktree",
        keepWorktree: false,
        responseMode: "compact",
      },
    );

    expect(r.warnings).not.toContain("DIFF_DISCARDED_NO_ARTIFACT");
    expect(r.diff_artifact_path).toBeTruthy();
    // The artifact outlives the reaped worktree.
    expect(fs.existsSync(r.diff_artifact_path!)).toBe(true);
    expect(fs.readFileSync(r.diff_artifact_path!, "utf8")).toContain("out.txt");
  });

  it("keep_worktree=false with a full diff is never flagged", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const r = await runTool(
      { ...ctx, config: { ...ctx.config, grokBin: mockWritingLines(3) } },
      {
        tool: "grok_implement",
        prompt: "make a change",
        workingDirectory: repo,
        mode: "write_worktree",
        keepWorktree: false,
        responseMode: "auto",
      },
    );

    expect(r.response_mode_effective).toBe("full");
    expect(r.warnings).not.toContain("DIFF_DISCARDED_NO_ARTIFACT");
    expect(r.diff).toContain("out.txt");
  });
});

describe("artifact write failure degrades safely", () => {
  it("falls back to summary_only instead of inlining a huge diff", async () => {
    const outside = tmp("cgm-rm-blocked-");
    const blocked = path.join(outside, "cache-is-a-file");
    fs.writeFileSync(blocked, "not a directory\n");

    const repo = initRepo();
    const ctx = makeCtx(
      makeConfig({
        cacheDir: blocked,
        sessionStorePath: path.join(outside, "sessions.json"),
        worktreesRoot: path.join(outside, "worktrees"),
      }),
    );
    const r = await implement({
      ctx,
      repo,
      grokBin: mockWritingLines(1200),
      responseMode: "compact",
    });

    expect(r.warnings).toContain("DIFF_ARTIFACT_WRITE_FAILED");
    expect(r.response_mode_effective).toBe("summary_only");
    expect(r.diff).toBe("");
    expect(r.diff_artifact_path).toBeNull();

    // Nothing essential was lost.
    expect(r.summary).toContain("mock grok");
    expect(r.changed_files).toContain("out.txt");
    expect(r.worktree_path).toBeTruthy();
    expect(r.diff_bytes).toBeGreaterThan(65_536);
    expect(r.diff_sha256).toHaveLength(64);
    expect(r.diff_stats.files_changed).toBe(1);
  });
});

describe("grok_continue honours a per-call response_mode", () => {
  it("switches from compact to full on the follow-up call", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const first = await implement({
      ctx,
      repo,
      grokBin: mockWritingLines(1200),
      responseMode: "compact",
    });
    expect(first.response_mode_effective).toBe("compact");
    expect(first.session_id).toBe("mock-session-id");
    const firstArtifact = first.diff_artifact_path!;

    const second = await runTool(
      { ...ctx, config: { ...ctx.config, grokBin: writeMockGrok("true") } },
      {
        tool: "grok_continue",
        prompt: "keep going",
        workingDirectory: repo,
        mode: "write_worktree",
        resumeSessionId: first.session_id!,
        worktreePathOverride: first.worktree_path!,
        keepWorktree: true,
        responseMode: "full",
      },
    );

    expect(second.response_mode_requested).toBe("full");
    expect(second.response_mode_effective).toBe("full");
    expect(second.diff_included).toBe(true);
    expect(second.diff).toContain("out.txt");
    expect(second.worktree_path).toBe(first.worktree_path);
    // Prior artifacts are retained until TTL GC; the new call simply does not add one.
    expect(fs.existsSync(firstArtifact)).toBe(true);
    expect(second.diff_artifact_path).toBeNull();
  });

  it("defaults to auto per call rather than inheriting the prior mode", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const first = await implement({
      ctx,
      repo,
      grokBin: mockWritingLines(3),
      responseMode: "summary_only",
    });
    expect(first.response_mode_effective).toBe("summary_only");

    const second = await runTool(
      { ...ctx, config: { ...ctx.config, grokBin: writeMockGrok("true") } },
      {
        tool: "grok_continue",
        prompt: "keep going",
        workingDirectory: repo,
        mode: "write_worktree",
        resumeSessionId: first.session_id!,
        worktreePathOverride: first.worktree_path!,
        keepWorktree: true,
      },
    );

    expect(second.response_mode_requested).toBe("auto");
    expect(second.response_mode_effective).toBe("full");
    expect(second.diff_included).toBe(true);
  });

  it("continue in compact writes a distinct artifact per call", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const first = await implement({
      ctx,
      repo,
      grokBin: mockWritingLines(1200),
      responseMode: "compact",
    });

    const second = await runTool(
      { ...ctx, config: { ...ctx.config, grokBin: writeMockGrok("true") } },
      {
        tool: "grok_continue",
        prompt: "again",
        workingDirectory: repo,
        mode: "write_worktree",
        resumeSessionId: first.session_id!,
        worktreePathOverride: first.worktree_path!,
        keepWorktree: true,
        responseMode: "compact",
      },
    );

    expect(second.diff_artifact_path).toBeTruthy();
    expect(second.diff_artifact_path).not.toBe(first.diff_artifact_path);
    // Same session → same scope directory.
    expect(path.dirname(second.diff_artifact_path!)).toBe(
      path.dirname(first.diff_artifact_path!),
    );
    expect(fs.existsSync(first.diff_artifact_path!)).toBe(true);
  });
});

describe("read_only safety is unchanged by response_mode", () => {
  it("read_only still suppresses pre-existing WIP and rejects test_command", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    fs.writeFileSync(path.join(repo, "caller-wip.txt"), "user work in progress\n");

    const r = await runTool(
      { ...ctx, config: { ...ctx.config, grokBin: writeMockGrok("true") } },
      {
        tool: "grok_analyze",
        prompt: "explain",
        workingDirectory: repo,
        mode: "read_only",
        responseMode: "compact",
      },
    );

    // Pre-existing WIP is not surfaced, so there is nothing to store.
    expect(r.diff).toBe("");
    expect(r.diff_bytes).toBe(0);
    expect(r.diff_artifact_path).toBeNull();
    expect(r.worktree_path).toBeNull();
    expect(r.warnings).not.toContain("UNEXPECTED_MUTATION");
    expect(fs.existsSync(diffArtifactsRoot(ctx.config.cacheDir))).toBe(false);

    await expect(
      runTool(
        { ...ctx, config: { ...ctx.config, grokBin: writeMockGrok("true") } },
        {
          tool: "grok_analyze",
          prompt: "explain",
          workingDirectory: repo,
          mode: "read_only",
          testCommand: "echo hi",
          responseMode: "full",
        },
      ),
    ).rejects.toMatchObject({ code: "GROK_MCP_INVALID_ARGS" });
  });

  it("read_only mutation is still reported and can be routed to an artifact", async () => {
    const repo = initRepo();
    const ctx = makeCtx(makeConfig());
    const r = await runTool(
      { ...ctx, config: { ...ctx.config, grokBin: mockWritingLines(1200) } },
      {
        tool: "grok_analyze",
        prompt: "explain",
        workingDirectory: repo,
        mode: "read_only",
        responseMode: "auto",
      },
    );

    expect(r.warnings).toContain("UNEXPECTED_MUTATION");
    expect(r.response_mode_effective).toBe("compact");
    expect(r.diff_artifact_path).toBeTruthy();
    expect(fs.readFileSync(r.diff_artifact_path!, "utf8")).toContain("out.txt");
    expect(r.next_actions[0]).toContain("effective_cwd");
  });
});
