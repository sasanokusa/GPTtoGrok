import { describe, expect, it } from "vitest";
import { GrokMcpError, redactErrorFields } from "../../src/errors.js";
import {
  filterSecretPaths,
  isSecretPath,
  redactText,
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
