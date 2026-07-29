import { describe, expect, it } from "vitest";
import { AnalyzeInputSchema } from "../../src/types.js";

const base = {
  prompt: "explain path guard",
  working_directory: "/tmp/repo",
};

describe("AnalyzeInputSchema", () => {
  it("accepts a minimal read_only payload", () => {
    const parsed = AnalyzeInputSchema.parse(base);
    expect(parsed.prompt).toBe(base.prompt);
    expect(parsed.working_directory).toBe(base.working_directory);
  });

  it("accepts safe permission_mode and sandbox values", () => {
    const parsed = AnalyzeInputSchema.parse({
      ...base,
      permission_mode: "dontAsk",
      sandbox: "read-only",
    });
    expect(parsed.permission_mode).toBe("dontAsk");
    expect(parsed.sandbox).toBe("read-only");
  });

  it("rejects test_command at parse time", () => {
    const result = AnalyzeInputSchema.safeParse({
      ...base,
      test_command: "npm test",
    });
    expect(result.success).toBe(false);
  });

  it("rejects test_timeout_ms and fail_on_test_failure at parse time", () => {
    expect(
      AnalyzeInputSchema.safeParse({ ...base, test_timeout_ms: 1000 }).success,
    ).toBe(false);
    expect(
      AnalyzeInputSchema.safeParse({ ...base, fail_on_test_failure: true })
        .success,
    ).toBe(false);
  });

  it('rejects permission_mode "bypassPermissions" at parse time', () => {
    const result = AnalyzeInputSchema.safeParse({
      ...base,
      permission_mode: "bypassPermissions",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsafe sandbox values at parse time", () => {
    expect(
      AnalyzeInputSchema.safeParse({ ...base, sandbox: "off" }).success,
    ).toBe(false);
    expect(
      AnalyzeInputSchema.safeParse({ ...base, sandbox: "workspace" }).success,
    ).toBe(false);
  });

  it("accepts sandbox profiles other than read-only", () => {
    // `grok --sandbox <PROFILE>` is free-form; only the unsafe set is rejected,
    // so a future/custom profile must not be blocked here.
    const parsed = AnalyzeInputSchema.parse({ ...base, sandbox: "strict" });
    expect(parsed.sandbox).toBe("strict");
    expect(AnalyzeInputSchema.safeParse({ ...base, sandbox: "" }).success).toBe(
      false,
    );
  });
});
