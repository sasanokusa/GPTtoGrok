import path from "node:path";

export interface RedactConfig {
  secretBasenames: string[];
  aggressive: boolean;
}

const SECRET_BASENAME_SET_DEFAULT = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.test",
  "auth.json",
  "id_rsa",
  "id_ed25519",
  "id_dsa",
  "id_ecdsa",
  "credentials.json",
  "service-account.json",
  ".npmrc",
  ".pypirc",
]);

const HIGH_CONFIDENCE_EXT = new Set([".pem", ".p12", ".pfx", ".key"]);

/** Patterns that catch pasted secrets in free text (summary / stderr / tests). */
const SECRET_CONTENT_PATTERNS: RegExp[] = [
  /\b(?:sk|rk|pk|api)[-_][A-Za-z0-9]{16,}\b/g,
  /\b(?:xai|openai|anthropic|aws|ghp|gho|ghu|ghs|ghr)[-_][A-Za-z0-9_]{16,}\b/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /(?<=(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)["']?[^\s"']{8,}["']?/gi,
  /\bBearer\s+[A-Za-z0-9._\-+=/]{20,}\b/g,
];

export function isSecretPath(filePath: string, cfg: RedactConfig): boolean {
  const base = path.basename(filePath);
  const lower = base.toLowerCase();
  const basenames = new Set(
    [...SECRET_BASENAME_SET_DEFAULT, ...cfg.secretBasenames].map((b) =>
      b.toLowerCase(),
    ),
  );

  if (basenames.has(lower)) return true;
  if (lower.startsWith(".env.")) return true;
  if (HIGH_CONFIDENCE_EXT.has(path.extname(lower))) return true;

  // Known key file patterns
  if (/^id_(rsa|ed25519|dsa|ecdsa)(\.pub)?$/.test(lower) && !lower.endsWith(".pub")) {
    return true;
  }

  if (cfg.aggressive) {
    if (/\b(secret|token|credential|private[_-]?key)\b/i.test(base)) return true;
  }

  return false;
}

export function filterSecretPaths(
  files: string[],
  cfg: RedactConfig,
): { kept: string[]; redacted: string[] } {
  const kept: string[] = [];
  const redacted: string[] = [];
  for (const f of files) {
    if (isSecretPath(f, cfg)) redacted.push(f);
    else kept.push(f);
  }
  return { kept, redacted };
}

/**
 * Content redaction with a substitution flag.
 *
 * `redacted` is true only when a {@link SECRET_CONTENT_PATTERNS} match was
 * rewritten to `[REDACTED]`. Optional `maxBytes` truncation (which appends
 * `... [truncated]`) is a separate concern and does **not** set the flag —
 * callers that need completeness for applyable patches should not pass a cap.
 */
export function redactTextWithFlag(
  text: string,
  maxBytes?: number,
): { text: string; redacted: boolean } {
  let out = text;
  let redacted = false;
  for (const re of SECRET_CONTENT_PATTERNS) {
    // Reset lastIndex for global patterns so repeated calls are deterministic.
    re.lastIndex = 0;
    const next = out.replace(re, "[REDACTED]");
    if (next !== out) redacted = true;
    out = next;
  }
  if (maxBytes != null && Buffer.byteLength(out, "utf8") > maxBytes) {
    // Truncate by code units carefully
    let truncated = out;
    while (Buffer.byteLength(truncated, "utf8") > maxBytes - 32 && truncated.length > 0) {
      truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
    }
    out = `${truncated}\n... [truncated]`;
  }
  return { text: out, redacted };
}

export function redactText(text: string, maxBytes?: number): string {
  return redactTextWithFlag(text, maxBytes).text;
}

/** Strip absolute host paths that might appear in diffs (defense in depth). */
export function stripHomePaths(text: string, home: string): string {
  if (!home) return text;
  const esc = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(esc, "g"), "~");
}
