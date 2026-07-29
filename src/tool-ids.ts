/** Canonical Grok built-in tool IDs used for allow/deny lists. */

export const READ_ONLY_TOOLS = ["read_file", "grep", "list_dir"] as const;

/** Shell + write + escape hatches. Docs disagree on shell ID — deny both. */
export const WRITE_AND_ESCAPE_TOOLS = [
  "search_replace",
  "write",
  "run_terminal_cmd",
  "run_terminal_command",
  "Agent",
] as const;

export const DEFAULT_DISALLOWED_TOOLS = [...WRITE_AND_ESCAPE_TOOLS] as const;

export type ReadOnlyTool = (typeof READ_ONLY_TOOLS)[number];
export type DisallowedTool = (typeof DEFAULT_DISALLOWED_TOOLS)[number];

/**
 * Fail-closed read_only allowlist: caller may only *narrow* the configured list
 * (intersection). Unknown / mutating tools are dropped.
 *
 * Empty results are never returned: omitting `--tools` would let Grok expose all
 * tools. Empty caller override or empty intersection falls back to a nonempty
 * safe allowlist (configured list, else READ_ONLY_TOOLS).
 */
export function narrowReadOnlyTools(
  configuredAllow: readonly string[],
  callerTools?: string[],
): string[] {
  const safeFallback =
    configuredAllow.length > 0 ? [...configuredAllow] : [...READ_ONLY_TOOLS];

  // No override, or explicit empty array: keep safe allowlist (never open all tools).
  if (!callerTools?.length) return safeFallback;

  const allowSet = new Set(safeFallback);
  const narrowed = callerTools.filter((t) => allowSet.has(t));
  // Intersection empty (only mutating/unknown tools) → keep safe allowlist.
  return narrowed.length > 0 ? narrowed : safeFallback;
}

/**
 * Fail-closed denylist: always include mandatory defaults (both shell IDs + Agent
 * + writes), then union caller disallowed_tools.
 */
export function unionDisallowedTools(
  mandatoryDefaults: readonly string[],
  callerDisallowed?: string[],
): string[] {
  const set = new Set<string>([...mandatoryDefaults, ...DEFAULT_DISALLOWED_TOOLS]);
  for (const t of callerDisallowed ?? []) {
    if (t) set.add(t);
  }
  return [...set];
}
