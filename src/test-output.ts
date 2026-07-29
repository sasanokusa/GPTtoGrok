/**
 * Outcome-based capping of optional `test_command` output.
 *
 * `response_mode` governs the `diff` field only. Test output has its own
 * budgets so a compact/summary_only call still returns full failure forensics
 * while a green run cannot dominate the MCP response with thousands of ✓ lines.
 */

import { redactText } from "./redact.js";

/** Leading marker so the cut is visible at the start (failure summaries live at the end). */
export const TEST_OUTPUT_TRUNCATION_MARKER = "... [test output truncated] ";

/**
 * Keep the last `maxBytes` UTF-8 bytes of `text`, never splitting a multi-byte
 * character. No marker — used while streaming to bound memory.
 *
 * Uses a Buffer + continuation-byte backoff rather than `string.slice(-n)`,
 * which counts UTF-16 code units and can split a code point mid-stream.
 */
export function keepUtf8TailSilent(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  // Skip UTF-8 continuation bytes (0b10xxxxxx) so we never start mid-character.
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.toString("utf8", start);
}

/**
 * Keep the tail of `text` within `maxBytes` (including the marker), prepending
 * a truncation marker so the cut is at the beginning.
 *
 * Mirrors the byte-accurate approach of `applyAbsoluteDiffCap` in
 * `diff-artifact.ts`, but retains the **tail** (test runners put the failure
 * summary and final counts at the end).
 *
 * When `force` is true (e.g. the stream already dropped the head but the
 * retained tail still fits the budget), the marker is always applied so a cut
 * never looks whole.
 */
export function keepUtf8TailWithMarker(
  text: string,
  maxBytes: number,
  marker: string = TEST_OUTPUT_TRUNCATION_MARKER,
  force = false,
): { text: string; truncated: boolean; originalBytes?: number } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes && !force) {
    return { text, truncated: false };
  }

  const markerBytes = Buffer.byteLength(marker, "utf8");
  // Degenerate budget smaller than the marker: emit as much of the marker as fits.
  if (maxBytes <= markerBytes) {
    const mbuf = Buffer.from(marker, "utf8");
    return {
      text: mbuf.subarray(0, maxBytes).toString("utf8"),
      truncated: true,
      originalBytes: buf.length,
    };
  }

  // Forced and the whole body + marker still fit: just prepend.
  if (force && buf.length + markerBytes <= maxBytes) {
    return {
      text: marker + text,
      truncated: true,
      originalBytes: buf.length,
    };
  }

  let start = buf.length - (maxBytes - markerBytes);
  if (start < 0) start = 0;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;

  return {
    text: marker + buf.toString("utf8", start),
    truncated: true,
    originalBytes: buf.length,
  };
}

export interface FinalizeTestOutputOpts {
  /**
   * True when the stream buffer already dropped the head to stay under the
   * failure-budget memory bound. Always reported as truncated even if the
   * retained tail is under the final budget.
   */
  streamDropped?: boolean;
  /**
   * Total UTF-8 bytes received from the process before any stream trim.
   * Used as `original_output_bytes` when the stream dropped data.
   */
  rawReceivedBytes?: number;
}

/**
 * Redact then apply the outcome-based byte budget.
 *
 * Budget is chosen by exit_code, **not** by `response_mode`:
 * - `exit_code === 0` → success budget (small; green runs are noise)
 * - non-zero → full failure budget (forensics the caller needs)
 *
 * Do not couple this to compact/summary_only. Hiding why tests failed to save
 * response bytes is the wrong trade — keep the failure budget intact so that
 * later "optimisations" do not drop it.
 *
 * Redaction always runs first; truncation never skips `redactText`.
 */
export function finalizeTestOutput(
  raw: string,
  exitCode: number,
  maxFailureBytes: number,
  maxSuccessBytes: number,
  opts: FinalizeTestOutputOpts = {},
): {
  output: string;
  output_truncated: boolean;
  original_output_bytes?: number;
} {
  // Outcome budget — independent of response_mode (see module doc + comment above).
  const budget = exitCode === 0 ? maxSuccessBytes : maxFailureBytes;
  const redacted = redactText(raw);
  const redactedBytes = Buffer.byteLength(redacted, "utf8");
  const streamDropped = opts.streamDropped === true;

  if (redactedBytes <= budget && !streamDropped) {
    return { output: redacted, output_truncated: false };
  }

  // Prefer the true process size when the stream already dropped the head;
  // otherwise report the redacted length before the final budget cut.
  const originalBytes =
    streamDropped && opts.rawReceivedBytes != null
      ? Math.max(opts.rawReceivedBytes, redactedBytes)
      : redactedBytes;

  // Always mark the cut. `force` covers the stream-drop case where the retained
  // tail already fits the budget (without a marker it would look whole).
  const kept = keepUtf8TailWithMarker(
    redacted,
    budget,
    TEST_OUTPUT_TRUNCATION_MARKER,
    /* force */ true,
  );
  return {
    output: kept.text,
    output_truncated: true,
    original_output_bytes: originalBytes,
  };
}
