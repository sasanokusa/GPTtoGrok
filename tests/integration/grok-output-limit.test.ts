import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrokRunner, mapRunOutcomeToError } from "../../src/grok-runner.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeMockGrok(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-output-limit-"));
  tmpDirs.push(dir);
  const bin = path.join(dir, "mock-grok");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type: "text", data: "x".repeat(20000)}) + "\\n");\nsetTimeout(() => {}, 30000);\n`,
    { mode: 0o755 },
  );
  return bin;
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
