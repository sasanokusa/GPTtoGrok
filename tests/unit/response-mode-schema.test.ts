import { describe, expect, it } from "vitest";
import { parseToolInput } from "../../src/tools/common.js";
import {
  AnalyzeInputSchema,
  ContinueInputSchema,
  DebugInputSchema,
  ImplementInputSchema,
  ReviewInputSchema,
} from "../../src/types.js";

const BASE = {
  prompt: "do the thing",
  working_directory: "/tmp/project",
};
const CONTINUE_BASE = { ...BASE, session_id: "session-1" };

const WRITE_SCHEMAS = [
  ["grok_implement", ImplementInputSchema, BASE],
  ["grok_debug", DebugInputSchema, BASE],
  ["grok_continue", ContinueInputSchema, CONTINUE_BASE],
] as const;

describe("response_mode input schema", () => {
  it.each(WRITE_SCHEMAS)(
    "%s defaults to auto when response_mode is omitted (backward compatible)",
    (_name, schema, base) => {
      const parsed = parseToolInput(schema, base);
      expect(parsed.response_mode).toBe("auto");
    },
  );

  it.each(WRITE_SCHEMAS)("%s accepts every documented mode", (_n, schema, base) => {
    for (const mode of ["auto", "full", "compact", "summary_only"] as const) {
      expect(parseToolInput(schema, { ...base, response_mode: mode }).response_mode)
        .toBe(mode);
    }
  });

  it.each(WRITE_SCHEMAS)(
    "%s rejects an invalid response_mode with the versioned envelope",
    (_n, schema, base) => {
      try {
        parseToolInput(schema, { ...base, response_mode: "tiny" });
        throw new Error("expected parse to throw");
      } catch (err) {
        const body = (err as { toBody: () => Record<string, unknown> }).toBody();
        expect(body.error_version).toBe(1);
        expect(body.code).toBe("GROK_MCP_INVALID_ARGS");
        expect((body.details as { fields: string[] }).fields).toContain(
          "response_mode",
        );
      }
    },
  );

  it("read_only tools accept response_mode too (analyze is strict about unknown keys)", () => {
    expect(
      parseToolInput(AnalyzeInputSchema, { ...BASE, response_mode: "compact" })
        .response_mode,
    ).toBe("compact");
    expect(
      parseToolInput(ReviewInputSchema, { ...BASE, response_mode: "summary_only" })
        .response_mode,
    ).toBe("summary_only");
    expect(parseToolInput(AnalyzeInputSchema, BASE).response_mode).toBe("auto");
  });

  it("analyze still rejects unknown keys and test_command", () => {
    expect(() =>
      parseToolInput(AnalyzeInputSchema, { ...BASE, test_command: "npm test" }),
    ).toThrow();
    expect(() =>
      parseToolInput(AnalyzeInputSchema, { ...BASE, response_modes: "full" }),
    ).toThrow();
  });
});
