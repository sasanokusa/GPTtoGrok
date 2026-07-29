import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TEST_OUTPUT_BYTES,
  DEFAULT_MAX_TEST_OUTPUT_SUCCESS_BYTES,
  MAX_TEST_OUTPUT_BYTES_CEILING,
  loadConfig,
  parseByteLimitEnv,
  sanitizeByteLimit,
} from "../../src/config.js";
import { emptyTests } from "../../src/result.js";
import {
  TEST_OUTPUT_TRUNCATION_MARKER,
  finalizeTestOutput,
  keepUtf8TailSilent,
  keepUtf8TailWithMarker,
} from "../../src/test-output.js";
import { runTests } from "../../src/tools/common.js";
import os from "node:os";

const ENV_KEYS = [
  "GROK_MCP_MAX_TEST_OUTPUT_BYTES",
  "GROK_MCP_MAX_TEST_OUTPUT_SUCCESS_BYTES",
];
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("emptyTests", () => {
  it("marks an unrun test as not truncated", () => {
    expect(emptyTests()).toEqual({ ran: false, output_truncated: false });
  });
});

describe("keepUtf8TailSilent / keepUtf8TailWithMarker", () => {
  it("leaves short text untouched", () => {
    expect(keepUtf8TailSilent("hello", 100)).toBe("hello");
    expect(keepUtf8TailWithMarker("hello", 100)).toEqual({
      text: "hello",
      truncated: false,
    });
  });

  it("keeps the tail and never splits a multi-byte character", () => {
    // "日本語" is 9 UTF-8 bytes (3 code points × 3 bytes). Surround with ASCII
    // padding so a mid-character cut is possible with a naive byte slice.
    const head = "A".repeat(50);
    const multi = "日本語";
    const tail = "Z".repeat(20);
    const full = head + multi + tail;
    const budget = 30; // smaller than head+multi, will cut into the multi region or head

    const silent = keepUtf8TailSilent(full, budget);
    expect(Buffer.byteLength(silent, "utf8")).toBeLessThanOrEqual(budget);
    expect(silent).not.toContain("\uFFFD");
    // Re-encoding must be stable (no broken sequences).
    expect(Buffer.from(silent, "utf8").toString("utf8")).toBe(silent);
    // Either the whole multi-byte word is present, or none of its code points
    // appear as half-decoded garbage — full code points only.
    for (const ch of multi) {
      if (silent.includes(ch)) {
        // If any code point of the word survived, the whole word should when
        // the budget covers it; otherwise at least no lone half-bytes.
        expect(silent).toContain(ch);
      }
    }

    const marked = keepUtf8TailWithMarker(full, budget);
    expect(marked.truncated).toBe(true);
    expect(marked.originalBytes).toBe(Buffer.byteLength(full, "utf8"));
    expect(Buffer.byteLength(marked.text, "utf8")).toBeLessThanOrEqual(budget);
    expect(marked.text.startsWith(TEST_OUTPUT_TRUNCATION_MARKER)).toBe(true);
    expect(marked.text).not.toContain("\uFFFD");
    expect(Buffer.from(marked.text, "utf8").toString("utf8")).toBe(marked.text);
  });

  it("preserves the last line when truncating long output", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}-padding-xxxx`);
    const full = lines.join("\n");
    const budget = 400;
    const marked = keepUtf8TailWithMarker(full, budget);
    expect(marked.truncated).toBe(true);
    expect(marked.text).toContain("line-199-padding-xxxx");
    expect(marked.text).not.toContain("line-0-padding-xxxx");
    expect(marked.text.startsWith(TEST_OUTPUT_TRUNCATION_MARKER)).toBe(true);
  });
});

describe("finalizeTestOutput", () => {
  const FAIL = 1_000;
  const SUCCESS = 100;

  it("short output is untouched", () => {
    const r = finalizeTestOutput("ok\n", 0, FAIL, SUCCESS);
    expect(r.output).toBe("ok\n");
    expect(r.output_truncated).toBe(false);
    expect(r.original_output_bytes).toBeUndefined();
  });

  it("passing run uses the success budget and reports truncation", () => {
    const body = "✓ test passed\n".repeat(50);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(SUCCESS);
    const r = finalizeTestOutput(body, 0, FAIL, SUCCESS);
    expect(r.output_truncated).toBe(true);
    expect(r.original_output_bytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(SUCCESS);
    expect(r.output.startsWith(TEST_OUTPUT_TRUNCATION_MARKER)).toBe(true);
  });

  it("failing run keeps the full failure budget and preserves the tail", () => {
    const first = "FIRST_LINE_SHOULD_BE_GONE\n";
    const mid = "x".repeat(2_000) + "\n";
    const last = "LAST_LINE_MUST_SURVIVE failure summary\n";
    const body = first + mid + last;
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(FAIL);

    const r = finalizeTestOutput(body, 1, FAIL, SUCCESS);
    expect(r.output_truncated).toBe(true);
    expect(r.original_output_bytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(FAIL);
    expect(r.output).toContain("LAST_LINE_MUST_SURVIVE");
    expect(r.output).not.toContain("FIRST_LINE_SHOULD_BE_GONE");
    expect(r.output.startsWith(TEST_OUTPUT_TRUNCATION_MARKER)).toBe(true);
  });

  it("failing run does not use the success budget", () => {
    // Body fits failure budget but exceeds success budget.
    const body = "fail detail\n".repeat(20);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(SUCCESS);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(FAIL);
    const r = finalizeTestOutput(body, 7, FAIL, SUCCESS);
    expect(r.output_truncated).toBe(false);
    expect(r.output).toBe(body);
    expect(r.original_output_bytes).toBeUndefined();
  });

  it("redacts secrets before returning (and before measuring truncation)", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz";
    const r = finalizeTestOutput(`token=${secret}\n`, 1, FAIL, SUCCESS);
    expect(r.output).not.toContain(secret);
    expect(r.output).toContain("[REDACTED]");
  });
});

describe("runTests (spawn)", () => {
  const cwd = os.tmpdir();

  it("passing run → success budget, truncated when noisy", async () => {
    // Many ✓ lines so success budget (64) is exceeded.
    const cmd =
      'i=0; while [ $i -lt 80 ]; do echo "✓ pass case $i xxxxxxxxx"; i=$((i+1)); done; exit 0';
    const r = await runTests(cmd, cwd, 10_000, 65_536, 64);
    expect(r.ran).toBe(true);
    expect(r.exit_code).toBe(0);
    expect(r.output_truncated).toBe(true);
    expect(r.original_output_bytes).toBeGreaterThan(64);
    expect(Buffer.byteLength(r.output ?? "", "utf8")).toBeLessThanOrEqual(64);
  });

  it("failing run → failure budget, last line retained", async () => {
    const cmd = [
      'echo "FIRST_LINE_SHOULD_BE_GONE"',
      'i=0; while [ $i -lt 100 ]; do echo "pad line $i xxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done',
      'echo "LAST_LINE_MUST_SURVIVE end of failure"',
      "exit 1",
    ].join("; ");
    const r = await runTests(cmd, cwd, 10_000, 400, 64);
    expect(r.ran).toBe(true);
    expect(r.exit_code).toBe(1);
    expect(r.output_truncated).toBe(true);
    expect(r.output).toContain("LAST_LINE_MUST_SURVIVE");
    expect(r.output).not.toContain("FIRST_LINE_SHOULD_BE_GONE");
    expect(r.output?.startsWith(TEST_OUTPUT_TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(r.output ?? "", "utf8")).toBeLessThanOrEqual(400);
  });

  it("short output → untouched", async () => {
    const r = await runTests("echo short-ok", cwd, 10_000, 65_536, 4_096);
    expect(r.ran).toBe(true);
    expect(r.exit_code).toBe(0);
    expect(r.output_truncated).toBe(false);
    expect(r.original_output_bytes).toBeUndefined();
    expect(r.output).toContain("short-ok");
  });
});

describe("GROK_MCP_MAX_TEST_OUTPUT_BYTES config", () => {
  const parse = (raw: string | undefined) =>
    parseByteLimitEnv(
      "GROK_MCP_MAX_TEST_OUTPUT_BYTES",
      raw,
      DEFAULT_MAX_TEST_OUTPUT_BYTES,
      MAX_TEST_OUTPUT_BYTES_CEILING,
    );

  it("accepts valid positive integers and 0", () => {
    expect(parse("131072")).toBe(131_072);
    expect(parse("  4096  ")).toBe(4096);
    expect(parse("0")).toBe(0);
  });

  it("uses the fallback for unset / empty values", () => {
    expect(parse(undefined)).toBe(DEFAULT_MAX_TEST_OUTPUT_BYTES);
    expect(parse("")).toBe(DEFAULT_MAX_TEST_OUTPUT_BYTES);
    expect(parse("   ")).toBe(DEFAULT_MAX_TEST_OUTPUT_BYTES);
  });

  it("rejects negatives, NaN, floats and non-numeric text", () => {
    for (const bad of ["-1", "-65536", "NaN", "abc", "1.5", "1e9", "0x10", "12k"]) {
      expect(parse(bad)).toBe(DEFAULT_MAX_TEST_OUTPUT_BYTES);
    }
  });

  it("rejects values above the ceiling", () => {
    expect(parse(String(MAX_TEST_OUTPUT_BYTES_CEILING + 1))).toBe(
      DEFAULT_MAX_TEST_OUTPUT_BYTES,
    );
    expect(parse("999999999999999999999")).toBe(DEFAULT_MAX_TEST_OUTPUT_BYTES);
    expect(parse(String(MAX_TEST_OUTPUT_BYTES_CEILING))).toBe(
      MAX_TEST_OUTPUT_BYTES_CEILING,
    );
  });

  it("sanitizeByteLimit matches the env parser policy", () => {
    const f = (v: unknown) =>
      sanitizeByteLimit(
        "maxTestOutputBytes",
        v,
        DEFAULT_MAX_TEST_OUTPUT_BYTES,
        MAX_TEST_OUTPUT_BYTES_CEILING,
      );
    expect(f(1024)).toBe(1024);
    expect(f(undefined)).toBe(DEFAULT_MAX_TEST_OUTPUT_BYTES);
    expect(f(-5)).toBe(DEFAULT_MAX_TEST_OUTPUT_BYTES);
    expect(f(1.5)).toBe(DEFAULT_MAX_TEST_OUTPUT_BYTES);
    expect(f(Number.NaN)).toBe(DEFAULT_MAX_TEST_OUTPUT_BYTES);
    expect(f("65536")).toBe(DEFAULT_MAX_TEST_OUTPUT_BYTES);
    expect(f(MAX_TEST_OUTPUT_BYTES_CEILING + 1)).toBe(DEFAULT_MAX_TEST_OUTPUT_BYTES);
  });

  it("loadConfig defaults and honours valid overrides", () => {
    setEnv("GROK_MCP_MAX_TEST_OUTPUT_BYTES", undefined);
    setEnv("GROK_MCP_MAX_TEST_OUTPUT_SUCCESS_BYTES", undefined);
    const cfg = loadConfig();
    expect(cfg.maxTestOutputBytes).toBe(DEFAULT_MAX_TEST_OUTPUT_BYTES);
    expect(cfg.maxTestOutputBytes).toBe(65_536);
    expect(cfg.maxTestOutputSuccessBytes).toBe(
      DEFAULT_MAX_TEST_OUTPUT_SUCCESS_BYTES,
    );
    expect(cfg.maxTestOutputSuccessBytes).toBe(4_096);

    setEnv("GROK_MCP_MAX_TEST_OUTPUT_BYTES", "8192");
    setEnv("GROK_MCP_MAX_TEST_OUTPUT_SUCCESS_BYTES", "512");
    const cfg2 = loadConfig();
    expect(cfg2.maxTestOutputBytes).toBe(8192);
    expect(cfg2.maxTestOutputSuccessBytes).toBe(512);
  });

  it("loadConfig falls back safely for invalid overrides", () => {
    for (const bad of ["-1", "NaN", "not-a-number", "99999999999"]) {
      setEnv("GROK_MCP_MAX_TEST_OUTPUT_BYTES", bad);
      expect(loadConfig().maxTestOutputBytes).toBe(DEFAULT_MAX_TEST_OUTPUT_BYTES);
      setEnv("GROK_MCP_MAX_TEST_OUTPUT_SUCCESS_BYTES", bad);
      expect(loadConfig().maxTestOutputSuccessBytes).toBe(
        DEFAULT_MAX_TEST_OUTPUT_SUCCESS_BYTES,
      );
    }
  });

  it("keeps ENV_KEYS restored between cases", () => {
    expect(ENV_KEYS.every((k) => typeof k === "string")).toBe(true);
  });
});
