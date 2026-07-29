import { redactText } from "./redact.js";

export type GrokMcpErrorCode =
  | "GROK_MCP_INVALID_ARGS"
  | "GROK_MCP_PATH_NOT_ALLOWED"
  | "GROK_MCP_PATH_TRAVERSAL"
  | "GROK_MCP_NOT_A_DIRECTORY"
  | "GROK_MCP_NOT_A_GIT_REPO"
  | "GROK_MCP_GROK_NOT_FOUND"
  | "GROK_MCP_GROK_ERROR"
  | "GROK_MCP_GROK_EXIT"
  | "GROK_MCP_TIMEOUT"
  | "GROK_MCP_CANCELLED"
  | "GROK_MCP_BUSY"
  | "GROK_MCP_WORKTREE_EXISTS"
  | "GROK_MCP_WORKTREE_MISSING"
  | "GROK_MCP_WORKTREE_CREATE_FAILED"
  | "GROK_MCP_WORKTREE_INVALID"
  | "GROK_MCP_SESSION_NOT_FOUND"
  | "GROK_MCP_ORIGINAL_TREE_DIRTY"
  | "GROK_MCP_TESTS_FAILED"
  | "GROK_MCP_INTERNAL";

export interface GrokMcpErrorBody {
  error_version: 1;
  code: GrokMcpErrorCode;
  message: string;
  details?: {
    exit_code?: number;
    stderr_tail?: string;
    partial_summary?: string;
    session_id?: string | null;
    worktree_path?: string | null;
    warnings?: string[];
    [key: string]: unknown;
  };
}

function redactUnknown(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[REDACTED_DEPTH]";
  if (typeof value === "string") return redactText(value, 16_000);
  if (Array.isArray(value)) return value.map((v) => redactUnknown(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactUnknown(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class GrokMcpError extends Error {
  readonly code: GrokMcpErrorCode;
  readonly details?: GrokMcpErrorBody["details"];

  constructor(
    code: GrokMcpErrorCode,
    message: string,
    details?: GrokMcpErrorBody["details"],
  ) {
    super(message);
    this.name = "GrokMcpError";
    this.code = code;
    this.details = details;
  }

  toBody(): GrokMcpErrorBody {
    const redactedDetails = this.details
      ? (redactUnknown(this.details) as GrokMcpErrorBody["details"])
      : undefined;
    return {
      error_version: 1,
      code: this.code,
      message: redactText(this.message, 4000),
      ...(redactedDetails ? { details: redactedDetails } : {}),
    };
  }
}

export function isGrokMcpError(err: unknown): err is GrokMcpError {
  return err instanceof GrokMcpError;
}
