import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GrokMcpError } from "../../src/errors.js";
import { parseToolInput } from "../../src/tools/common.js";

const SampleSchema = z.object({
  working_directory: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
});

describe("parseToolInput", () => {
  it("returns parsed data on success", () => {
    const out = parseToolInput(SampleSchema, {
      working_directory: "/tmp/repo",
      timeout_ms: 1000,
    });
    expect(out).toEqual({
      working_directory: "/tmp/repo",
      timeout_ms: 1000,
    });
  });

  it("converts ZodError to GrokMcpError INVALID_ARGS with field names", () => {
    expect(() =>
      parseToolInput(SampleSchema, {
        working_directory: "",
        timeout_ms: -1,
      }),
    ).toThrow(GrokMcpError);

    try {
      parseToolInput(SampleSchema, {
        working_directory: "",
        timeout_ms: -1,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GrokMcpError);
      const e = err as GrokMcpError;
      expect(e.code).toBe("GROK_MCP_INVALID_ARGS");
      expect(e.message).toMatch(/working_directory|timeout_ms/);
      const body = e.toBody();
      expect(body.error_version).toBe(1);
      expect(body.code).toBe("GROK_MCP_INVALID_ARGS");
      expect(body.details?.fields).toEqual(
        expect.arrayContaining(["working_directory", "timeout_ms"]),
      );
    }
  });

  it("names missing required fields", () => {
    try {
      parseToolInput(SampleSchema, {});
      expect.unreachable();
    } catch (err) {
      const e = err as GrokMcpError;
      expect(e.code).toBe("GROK_MCP_INVALID_ARGS");
      expect(e.message).toMatch(/working_directory/);
    }
  });
});
