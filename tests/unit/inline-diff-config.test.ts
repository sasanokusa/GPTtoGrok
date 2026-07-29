import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INLINE_DIFF_HARD_MAX_BYTES,
  DEFAULT_INLINE_DIFF_MAX_BYTES,
  DEFAULT_MAX_DIFF_BYTES,
  INLINE_DIFF_BYTES_CEILING,
  MAX_DIFF_BYTES_CEILING,
  loadConfig,
  parseByteLimitEnv,
  sanitizeByteLimit,
} from "../../src/config.js";

const ENV_KEYS = [
  "GROK_MCP_INLINE_DIFF_MAX_BYTES",
  "GROK_MCP_INLINE_DIFF_HARD_MAX_BYTES",
  "GROK_MCP_MAX_DIFF_BYTES",
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

const FALLBACK = 65_536;
const parse = (raw: string | undefined) =>
  parseByteLimitEnv("TEST_LIMIT", raw, FALLBACK, INLINE_DIFF_BYTES_CEILING);

describe("parseByteLimitEnv", () => {
  it("accepts valid positive integers", () => {
    expect(parse("131072")).toBe(131_072);
    expect(parse("  4096  ")).toBe(4096);
  });

  it("accepts 0 (never inline)", () => {
    expect(parse("0")).toBe(0);
  });

  it("uses the fallback for unset / empty values", () => {
    expect(parse(undefined)).toBe(FALLBACK);
    expect(parse("")).toBe(FALLBACK);
    expect(parse("   ")).toBe(FALLBACK);
  });

  it("rejects negatives, NaN, floats and non-numeric text", () => {
    for (const bad of ["-1", "-65536", "NaN", "abc", "1.5", "1e9", "0x10", "12k"]) {
      expect(parse(bad)).toBe(FALLBACK);
    }
  });

  it("rejects values above the ceiling", () => {
    expect(parse(String(INLINE_DIFF_BYTES_CEILING + 1))).toBe(FALLBACK);
    expect(parse("999999999999999999999")).toBe(FALLBACK);
    expect(parse(String(INLINE_DIFF_BYTES_CEILING))).toBe(
      INLINE_DIFF_BYTES_CEILING,
    );
  });
});

describe("sanitizeByteLimit (JSON config file)", () => {
  it("passes through valid integers and falls back otherwise", () => {
    const f = (v: unknown) =>
      sanitizeByteLimit("inlineDiffMaxBytes", v, FALLBACK, INLINE_DIFF_BYTES_CEILING);
    expect(f(1024)).toBe(1024);
    expect(f(undefined)).toBe(FALLBACK);
    expect(f(-5)).toBe(FALLBACK);
    expect(f(1.5)).toBe(FALLBACK);
    expect(f(Number.NaN)).toBe(FALLBACK);
    expect(f("65536")).toBe(FALLBACK);
    expect(f(INLINE_DIFF_BYTES_CEILING + 1)).toBe(FALLBACK);
  });
});

describe("loadConfig inline diff limits", () => {
  it("defaults to 64 KiB inline / 1 MiB hard cap", () => {
    setEnv("GROK_MCP_INLINE_DIFF_MAX_BYTES", undefined);
    setEnv("GROK_MCP_INLINE_DIFF_HARD_MAX_BYTES", undefined);
    const cfg = loadConfig();
    expect(cfg.inlineDiffMaxBytes).toBe(DEFAULT_INLINE_DIFF_MAX_BYTES);
    expect(cfg.inlineDiffMaxBytes).toBe(65_536);
    expect(cfg.inlineDiffHardMaxBytes).toBe(DEFAULT_INLINE_DIFF_HARD_MAX_BYTES);
  });

  it("honours a valid override", () => {
    setEnv("GROK_MCP_INLINE_DIFF_MAX_BYTES", "8192");
    expect(loadConfig().inlineDiffMaxBytes).toBe(8192);
  });

  it("falls back safely for an invalid override", () => {
    for (const bad of ["-1", "NaN", "not-a-number", "99999999999"]) {
      setEnv("GROK_MCP_INLINE_DIFF_MAX_BYTES", bad);
      expect(loadConfig().inlineDiffMaxBytes).toBe(DEFAULT_INLINE_DIFF_MAX_BYTES);
    }
  });

  it("keeps ENV_KEYS restored between cases", () => {
    expect(ENV_KEYS.every((k) => typeof k === "string")).toBe(true);
  });
});

describe("GROK_MCP_MAX_DIFF_BYTES (opt-in absolute cap)", () => {
  it("defaults to 0 = unlimited, so diffs are never truncated before response_mode", () => {
    expect(DEFAULT_MAX_DIFF_BYTES).toBe(0);
    setEnv("GROK_MCP_MAX_DIFF_BYTES", undefined);
    expect(loadConfig().maxDiffBytes).toBe(0);
  });

  it("accepts an explicit opt-in value", () => {
    setEnv("GROK_MCP_MAX_DIFF_BYTES", "4096");
    expect(loadConfig().maxDiffBytes).toBe(4096);
  });

  it("falls back to unlimited on invalid or out-of-range values", () => {
    for (const bad of ["-1", "abc", "1.5", "", String(MAX_DIFF_BYTES_CEILING + 1)]) {
      setEnv("GROK_MCP_MAX_DIFF_BYTES", bad);
      expect(loadConfig().maxDiffBytes).toBe(DEFAULT_MAX_DIFF_BYTES);
    }
  });

  it("allows a cap far above the inline ceiling (artifacts are on disk, not in context)", () => {
    setEnv("GROK_MCP_MAX_DIFF_BYTES", String(INLINE_DIFF_BYTES_CEILING * 4));
    expect(loadConfig().maxDiffBytes).toBe(INLINE_DIFF_BYTES_CEILING * 4);
  });
});
