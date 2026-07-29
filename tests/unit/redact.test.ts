import { describe, expect, it } from "vitest";
import { GrokMcpError, redactErrorFields } from "../../src/errors.js";
import {
  filterSecretPaths,
  isSecretPath,
  redactText,
  redactTextWithFlag,
} from "../../src/redact.js";

const cfg = {
  secretBasenames: [".env", "auth.json"],
  aggressive: false,
};

describe("redact", () => {
  it("flags high-confidence secret basenames", () => {
    expect(isSecretPath(".env", cfg)).toBe(true);
    expect(isSecretPath("src/.env.local", cfg)).toBe(true);
    expect(isSecretPath("keys/id_rsa", cfg)).toBe(true);
    expect(isSecretPath("cert.pem", cfg)).toBe(true);
  });

  it("does not flag legitimate source files by default", () => {
    expect(isSecretPath("csrf-token.ts", cfg)).toBe(false);
    expect(isSecretPath("SecretManager.swift", cfg)).toBe(false);
    expect(isSecretPath("src/config.ts", cfg)).toBe(false);
  });

  it("filters secret paths from lists", () => {
    const { kept, redacted } = filterSecretPaths(
      ["src/a.ts", ".env", "lib/b.ts", "id_ed25519"],
      cfg,
    );
    expect(kept).toEqual(["src/a.ts", "lib/b.ts"]);
    expect(redacted).toContain(".env");
    expect(redacted).toContain("id_ed25519");
  });

  it("redacts secret-like content in text", () => {
    const text = "key=sk-abcdefghijklmnopqrstuvwxyz token Bearer abcdefghijklmnopqrstuvwxyz1234";
    const out = redactText(text);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toMatch(/sk-abcdefgh/);
  });

  it("redactTextWithFlag reports content substitution", () => {
    const dirty =
      "key=sk-abcdefghijklmnopqrstuvwxyz token Bearer abcdefghijklmnopqrstuvwxyz1234";
    const clean = "export const n = 1;\nhello world\n";

    const dirtyFlag = redactTextWithFlag(dirty);
    expect(dirtyFlag.redacted).toBe(true);
    expect(dirtyFlag.text).toContain("[REDACTED]");
    expect(dirtyFlag.text).not.toMatch(/sk-abcdefgh/);
    // Wrapper compatibility: same bytes as redactText.
    expect(redactText(dirty)).toBe(dirtyFlag.text);

    const cleanFlag = redactTextWithFlag(clean);
    expect(cleanFlag.redacted).toBe(false);
    expect(cleanFlag.text).toBe(clean);
    expect(redactText(clean)).toBe(clean);
  });

  it("redactTextWithFlag does not leak global-regex lastIndex across calls", () => {
    const dirty = "sk-abcdefghijklmnopqrstuvwxyz";
    const a = redactTextWithFlag(dirty);
    const b = redactTextWithFlag(dirty);
    expect(a).toEqual(b);
    expect(a.redacted).toBe(true);
    expect(a.text).toBe("[REDACTED]");

    const clean = "no secrets here at all";
    expect(redactTextWithFlag(clean)).toEqual({ text: clean, redacted: false });
    // After a clean call, dirty still redacts the same way.
    expect(redactTextWithFlag(dirty)).toEqual(a);
  });

  it("maxBytes truncation does not set the redacted flag by itself", () => {
    const clean = "a".repeat(200);
    const r = redactTextWithFlag(clean, 40);
    expect(r.redacted).toBe(false);
    expect(r.text).toContain("... [truncated]");
    expect(redactText(clean, 40)).toBe(r.text);
  });
});

describe("error field redaction", () => {
  const secretSnippet =
    "password=supersecretvalue Bearer abcdefghijklmnopqrstuvwxyz1234 sk-abcdefghijklmnopqrstuvwxyz";

  it("redacts stderr_tail and partial_summary via redactErrorFields", () => {
    const { message, details } = redactErrorFields("failed with sk-abcdefghijklmnopqrstuvwxyz", {
      stderr_tail: `git error: ${secretSnippet}`,
      partial_summary: `agent said: ${secretSnippet}`,
      exit_code: 1,
    });

    expect(message).toContain("[REDACTED]");
    expect(message).not.toMatch(/sk-abcdefgh/);
    expect(details?.stderr_tail).toContain("[REDACTED]");
    expect(details?.stderr_tail).not.toMatch(/supersecretvalue|sk-abcdefgh|abcdefghijklmnopqrstuvwxyz1234/);
    expect(details?.partial_summary).toContain("[REDACTED]");
    expect(details?.partial_summary).not.toMatch(/supersecretvalue|sk-abcdefgh|abcdefghijklmnopqrstuvwxyz1234/);
    expect(details?.exit_code).toBe(1);
  });

  it("redacts stderr_tail and partial_summary on GrokMcpError construction", () => {
    const err = new GrokMcpError("GROK_MCP_GROK_EXIT", "exit after secret sk-abcdefghijklmnopqrstuvwxyz", {
      stderr_tail: secretSnippet,
      partial_summary: `summary ${secretSnippet}`,
      exit_code: 2,
    });

    expect(err.message).not.toMatch(/sk-abcdefgh/);
    expect(err.details?.stderr_tail).toContain("[REDACTED]");
    expect(err.details?.stderr_tail).not.toMatch(/supersecretvalue|sk-abcdefgh/);
    expect(err.details?.partial_summary).toContain("[REDACTED]");
    expect(err.details?.partial_summary).not.toMatch(/supersecretvalue|sk-abcdefgh/);

    const body = err.toBody();
    expect(body.details?.stderr_tail).not.toMatch(/supersecretvalue|sk-abcdefgh/);
    expect(body.details?.partial_summary).not.toMatch(/supersecretvalue|sk-abcdefgh/);
  });
});
