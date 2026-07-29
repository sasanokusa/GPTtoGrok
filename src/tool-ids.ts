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
