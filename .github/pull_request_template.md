## What changed

<!-- One paragraph. What behaviour is different, and why. -->

## Why

<!-- The problem this solves. Link an issue if there is one. -->

## Verification

<!-- Delete what does not apply. CI runs all three on ubuntu 20/22 and macOS 22. -->

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] Exercised against a real Grok run (not only mocks)

## Contract

- [ ] `result_version` / `error_version` unchanged, or the bump is deliberate and documented
- [ ] No public field removed or retyped (additive only — AGENTS.md #6)
- [ ] Input schema changes are reflected in README and `docs/design-codex-grok-mcp.md`

## Security checklist

Mirrors `AGENTS.md`; tick what the diff touches.

- [ ] No secrets logged or returned; redaction not weakened or reordered
- [ ] Path guard still rejects traversal / relative paths
- [ ] Isolation recipe unchanged unless the design doc was updated with it
- [ ] Both shell tool IDs still denied for `read_only`
- [ ] `test_command` execution not widened (host `/bin/sh -c`, still rejected in `read_only`, no login shell)
- [ ] Diff artifacts stay redacted, under the cache root, and resist symlink escape
- [ ] Artifact GC still refuses symlinks, unmanaged names, and paths outside the cache root
- [ ] A patch that is not whole still reports `diff_complete: false` (AGENTS.md #10)
- [ ] Nothing written to stdout (it would corrupt MCP stdio) — logs go to stderr
