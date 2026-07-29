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
 */
export function narrowReadOnlyTools(
  configuredAllow: readonly string[],
  callerTools?: string[],
): string[] {
  const allow = [...configuredAllow];
  if (!callerTools?.length) return allow;
  const allowSet = new Set(allow);
  return callerTools.filter((t) => allowSet.has(t));
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
