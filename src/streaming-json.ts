export type StreamEventType =
  | "text"
  | "thought"
  | "end"
  | "error"
  | "max_turns_reached"
  | string;

export interface StreamEvent {
  type: StreamEventType;
  data?: string;
  message?: string;
  sessionId?: string;
  stopReason?: string;
  requestId?: string;
  usage?: Record<string, unknown>;
  num_turns?: number;
  modelUsage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ParseResult {
  text: string;
  thoughts: string;
  sessionId: string | null;
  stopReason?: string;
  usage?: Record<string, unknown>;
  errorMessage?: string;
  maxTurnsReached: boolean;
  parseWarnings: string[];
  events: StreamEvent[];
}

/**
 * Incremental NDJSON parser for Grok streaming-json output.
 */
export class StreamingJsonParser {
  private buffer = "";
  private textParts: string[] = [];
  private thoughtParts: string[] = [];
  private sessionId: string | null = null;
  private stopReason?: string;
  private usage?: Record<string, unknown>;
  private errorMessage?: string;
  private maxTurnsReached = false;
  private parseWarnings: string[] = [];
  private events: StreamEvent[] = [];

  push(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  flush(): ParseResult {
    const rest = this.buffer.trim();
    if (rest) {
      this.handleLine(rest);
      this.buffer = "";
    }
    return this.result();
  }

  result(): ParseResult {
    return {
      text: this.textParts.join(""),
      thoughts: this.thoughtParts.join(""),
      sessionId: this.sessionId,
      stopReason: this.stopReason,
      usage: this.usage,
      errorMessage: this.errorMessage,
      maxTurnsReached: this.maxTurnsReached,
      parseWarnings: [...this.parseWarnings],
      events: [...this.events],
    };
  }

  private handleLine(line: string): void {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      this.parseWarnings.push(`Invalid JSON line: ${line.slice(0, 120)}`);
      return;
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      this.parseWarnings.push(`Missing type on event: ${line.slice(0, 120)}`);
      return;
    }
    this.events.push(event);
    switch (event.type) {
      case "text":
        if (typeof event.data === "string") this.textParts.push(event.data);
        break;
      case "thought":
        if (typeof event.data === "string") this.thoughtParts.push(event.data);
        break;
      case "end":
        if (typeof event.sessionId === "string") this.sessionId = event.sessionId;
        if (typeof event.stopReason === "string") this.stopReason = event.stopReason;
        if (event.usage && typeof event.usage === "object") {
          this.usage = event.usage as Record<string, unknown>;
        }
        break;
      case "error":
        if (typeof event.message === "string") this.errorMessage = event.message;
        else if (typeof event.data === "string") this.errorMessage = event.data;
        break;
      case "max_turns_reached":
        this.maxTurnsReached = true;
        break;
      default:
        // non-exhaustive: auto_compact_*, etc.
        break;
    }
  }
}
