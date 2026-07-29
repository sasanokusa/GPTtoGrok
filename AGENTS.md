# AGENTS.md — codex-grok-mcp

Guidance for coding agents working on this repository.

## What this project is

A **local stdio MCP server** that lets **Codex CLI / Codex IDE** delegate coding tasks to **Grok Build** via:

```bash
grok --no-auto-update -p <prompt> --output-format streaming-json
```

Five tools: `grok_analyze`, `grok_implement`, `grok_review`, `grok_debug`, `grok_continue`.

Design document: `docs/design-codex-grok-mcp.md`.

## Hard constraints

1. **Stdout is MCP only.** All logs go to **stderr** (`src/log.ts`).
2. **Never** put `.env`, private keys, `auth.json`, or credential files into prompts or tool results. Use `src/redact.ts`.
3. **`working_directory` must be absolute.** Relative paths are rejected (`src/path-guard.ts`).
4. **write_worktree default recipe**: create managed git worktree under cache **first**, then spawn Grok with `--cwd <worktree_path>` (**no** `-w`) and `--sandbox workspace`. Do not use `--cwd original -w --sandbox workspace`.
5. **read_only** denylist must include **both** `run_terminal_cmd` and `run_terminal_command`, plus `Agent` (`src/tool-ids.ts`).
6. Result contract is frozen at `result_version: 1` (`src/types.ts`, `src/result.ts`). Additive fields only — never remove or retype an existing field.
7. Codex example config **must** keep `tool_timeout_sec = 2400`.
8. **`response_mode` never changes what is redacted.** The order in `runTool` is fixed: collect → drop secret-path hunks → content redaction → measure bytes/hash → pick mode → inline **or** write artifact. `compact` must keep re-using the single redacted string; never re-collect a diff for the artifact, and never write an unredacted diff to a temp file (`src/diff-artifact.ts`, `applyResponseMode` in `src/tools/common.ts`).
9. **Never fall back to inlining a raw diff.** Artifact write failure degrades to `summary_only`; a `full` request over the hard cap degrades to `compact` with the patch stored whole. Both must warn.
10. Diff artifacts are written only under `<cacheDir>/diffs/<scope_digest>/<uuid>.diff` with `O_EXCL` + `0600` + `rename`. GC deletes only realpath-validated managed artifacts — never symlinks, unmanaged names, or anything outside the cache root.

## Layout

| Path | Role |
|------|------|
| `src/index.ts` | CLI entry |
| `src/server.ts` | MCP bootstrap + instructions |
| `src/tools/*` | Tool registration |
| `src/grok-runner.ts` | Spawn, queue, timeout, process-group cancel |
| `src/streaming-json.ts` | NDJSON parser |
| `src/worktree.ts` | Managed worktree create/remove |
| `src/git.ts` | Diff algorithm (apply-friendly) |
| `src/diff-artifact.ts` | `response_mode` sizing, diff artifact write/GC |
| `src/session-store.ts` | Atomic `sessions.json` |
| `examples/codex-config.toml` | Codex host config |

## Commands

```bash
npm install
npm test
npm run build
npm run dev   # run stdio server
```

## Testing notes

- Unit tests do **not** require a real Grok login.
- Integration tests use shell mock binaries under `tests/`.
- When changing the untracked diff format, keep the `git apply` unit test green.

## Security checklist for PRs

- [ ] No secrets logged or returned
- [ ] Path guard still rejects traversal / relative paths
- [ ] Isolation recipe unchanged unless design doc updated
- [ ] Both shell tool IDs still denied for read_only
- [ ] Do not widen `test_command` execution (host `/bin/sh -c` outside Grok sandbox; keep rejected in read_only; no login shell)
- [ ] Diff artifacts still contain only redacted content, stay under the cache root, and resist symlink escape
- [ ] Artifact GC still refuses symlinks, unmanaged names, and paths outside the cache root

## Out of scope

- Re-implementing Grok’s agent loop
- Remote MCP transport
- Auto-merge worktree changes into the original tree
- Windows as a primary platform (v1)
