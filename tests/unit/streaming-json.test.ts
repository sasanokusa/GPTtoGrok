import { describe, expect, it } from "vitest";
import { StreamingJsonParser } from "../../src/streaming-json.js";

describe("StreamingJsonParser", () => {
  it("parses text chunks and end sessionId", () => {
    const p = new StreamingJsonParser();
    p.push('{"type":"text","data":"Hello"}\n');
    p.push('{"type":"text","data":" world"}\n');
    p.push(
      '{"type":"end","stopReason":"EndTurn","sessionId":"abc-123","usage":{"input_tokens":1}}\n',
    );
    const r = p.flush();
    expect(r.text).toBe("Hello world");
    expect(r.sessionId).toBe("abc-123");
    expect(r.stopReason).toBe("EndTurn");
    expect(r.usage).toEqual({ input_tokens: 1 });
  });

  it("reassembles partial chunks across boundaries", () => {
    const p = new StreamingJsonParser();
    p.push('{"type":"te');
    p.push('xt","data":"x"}\n{"type":"end","sessionId":"s1"}\n');
    const r = p.flush();
    expect(r.text).toBe("x");
    expect(r.sessionId).toBe("s1");
  });

  it("records parse warnings for invalid lines", () => {
    const p = new StreamingJsonParser();
    p.push("not-json\n");
    p.push('{"type":"text","data":"ok"}\n');
    const r = p.flush();
    expect(r.text).toBe("ok");
    expect(r.parseWarnings.length).toBeGreaterThan(0);
  });

  it("captures thoughts and errors", () => {
    const p = new StreamingJsonParser();
    p.push('{"type":"thought","data":"hmm"}\n');
    p.push('{"type":"error","message":"boom"}\n');
    const r = p.flush();
    expect(r.thoughts).toBe("hmm");
    expect(r.errorMessage).toBe("boom");
  });

  it("ignores unknown event types", () => {
    const p = new StreamingJsonParser();
    p.push('{"type":"auto_compact_start"}\n');
    p.push('{"type":"text","data":"t"}\n');
    const r = p.flush();
    expect(r.text).toBe("t");
  });
});
