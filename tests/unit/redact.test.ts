import { describe, expect, it } from "vitest";
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
