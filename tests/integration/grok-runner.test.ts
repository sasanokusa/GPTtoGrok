import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrokMcpError } from "../../src/errors.js";
import { GrokRunner } from "../../src/grok-runner.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function writeMockGrok(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-mock-"));
  tmpDirs.push(dir);
  const bin = path.join(dir, "mock-grok");
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}

describe("GrokRunner integration", () => {
  it("parses streaming-json from mock binary", async () => {
    const bin = writeMockGrok(`#!/bin/sh
echo '{"type":"text","data":"ok"}'
echo '{"type":"end","sessionId":"mock-session","stopReason":"EndTurn"}'
exit 0
`);
    const runner = new GrokRunner(2, 8);
    const out = await runner.run({
      grokBin: bin,
      argv: ["--no-auto-update", "-p", "hi", "--output-format", "streaming-json"],
      spawnCwd: os.tmpdir(),
      timeoutMs: 5000,
      maxStderrBytes: 10_000,
    });
    expect(out.exitCode).toBe(0);
    expect(out.parse.text).toBe("ok");
    expect(out.parse.sessionId).toBe("mock-session");
    expect(out.timedOut).toBe(false);
  });

  it("cancels via AbortSignal and kills process group children", async () => {
    const bin = writeMockGrok(`#!/bin/sh
# spawn a child that would outlive a non-group kill
sleep 30 &
echo '{"type":"text","data":"started"}'
sleep 30
`);
    const runner = new GrokRunner(2, 8);
    const ac = new AbortController();
    const p = runner.run({
      grokBin: bin,
      argv: [],
      spawnCwd: os.tmpdir(),
      timeoutMs: 30_000,
      maxStderrBytes: 10_000,
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    const out = await p;
    expect(out.cancelled || out.exitCode !== 0).toBe(true);
  });

  it("times out long runs", async () => {
    const bin = writeMockGrok(`#!/bin/sh
sleep 10
`);
    const runner = new GrokRunner(2, 8);
    const out = await runner.run({
      grokBin: bin,
      argv: [],
      spawnCwd: os.tmpdir(),
      timeoutMs: 300,
      maxStderrBytes: 10_000,
    });
    expect(out.timedOut).toBe(true);
  });

  it("rejects when queue is full", async () => {
    const bin = writeMockGrok(`#!/bin/sh
sleep 2
echo '{"type":"end","sessionId":"x"}'
`);
    const runner = new GrokRunner(1, 1);
    const p1 = runner.run({
      grokBin: bin,
      argv: [],
      spawnCwd: os.tmpdir(),
      timeoutMs: 10_000,
      maxStderrBytes: 1000,
    });
    // fill active + queue
    const p2 = runner.run({
      grokBin: bin,
      argv: [],
      spawnCwd: os.tmpdir(),
      timeoutMs: 10_000,
      maxStderrBytes: 1000,
    });
    await expect(
      runner.run({
        grokBin: bin,
        argv: [],
        spawnCwd: os.tmpdir(),
        timeoutMs: 10_000,
        maxStderrBytes: 1000,
      }),
    ).rejects.toMatchObject({ code: "GROK_MCP_BUSY" });
    await Promise.allSettled([p1, p2]);
  });

  it("maps missing binary", async () => {
    const runner = new GrokRunner();
    await expect(
      runner.run({
        grokBin: "/nonexistent/grok-binary-xyz",
        argv: [],
        spawnCwd: os.tmpdir(),
        timeoutMs: 1000,
        maxStderrBytes: 1000,
      }),
    ).rejects.toBeInstanceOf(GrokMcpError);
  });
});
