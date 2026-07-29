# codex-grok-mcp

Local **stdio MCP server** that lets **Codex CLI** and **Codex IDE** delegate coding work to **[Grok Build](https://grok.x.ai/)** (headless CLI).

```text
Codex  --stdio MCP-->  codex-grok-mcp  --spawn-->  grok --no-auto-update -p … --output-format streaming-json
```

## Tools

| Tool | Default mode | Purpose |
|------|--------------|---------|
| `grok_analyze` | `read_only` | Explore / explain codebase |
| `grok_implement` | `write_worktree` | Implement features/fixes in an **isolated git worktree** |
| `grok_review` | `read_only` | Review changes (server injects `git diff` vs `base_ref`) |
| `grok_debug` | `write_worktree` | Debug / fix (optional `mode=read_only`) |
| `grok_continue` | inherit | Resume prior session (`--resume`) |

Every successful call returns versioned JSON (`result_version: 1`) with:

- `summary` — agent text (redacted)
- `changed_files` — relative paths (secret basenames omitted)
- `diff` — apply-friendly patch (untracked files included; **secret-path hunks omitted**). Empty string when `diff_included` is `false` — see [Response modes](#response-modes)
- `tests` — optional `test_command` result (**write_worktree only**; rejected in effective `read_only`)
- `session_id` — for `grok_continue`
- `worktree_path` — isolated tree for write modes
- `warnings` — e.g. `ORIGINAL_TREE_DIRTY`, `UNEXPECTED_MUTATION`, `REDACTED_SECRET_PATHS`
- `response_mode_requested` / `response_mode_effective`, `diff_included`, `diff_bytes`, `diff_sha256`, `diff_stats`, `diff_artifact_path`, `next_actions` — see [Response modes](#response-modes)

### Shared optional inputs

| Field | Notes |
|-------|--------|
| `reasoning_effort` | Public enum: `none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`. Mapped 1:1 to Grok CLI `--reasoning-effort`. |
| `model` | Passed as `-m`. For deeper analysis on current Grok, prefer **Grok 4.5** with `reasoning_effort: "high"`. |
| `test_command` | Allowed only when the **effective** mode is `write_worktree`. Effective `read_only` → `GROK_MCP_INVALID_ARGS`. |
| `response_mode` | `auto` (default) \| `full` \| `compact` \| `summary_only`. Controls how much diff the MCP response carries. See [Response modes](#response-modes). |
| `tools` / `disallowed_tools` | See [read_only policy](#readonly-policy) below. |
| `permission_mode` / `sandbox` / `allow_subagents` | Restricted in `read_only` (see below). |

Example (analyze with Grok 4.5 high effort):

```json
{
  "prompt": "Explain how path allowlisting works",
  "working_directory": "/ABS/PATH/TO/repo",
  "model": "grok-4.5",
  "reasoning_effort": "high"
}
```

## Response modes

A large Grok diff returned in full burns MCP response size and parent-model context on
every call. `response_mode` controls how much of the patch travels back to Codex /
Claude Code — **without** weakening isolation, redaction, or session continuity.

| Mode | `diff` body | Artifact on disk | Use when |
|------|-------------|------------------|----------|
| `auto` *(default)* | inlined while ≤ `GROK_MCP_INLINE_DIFF_MAX_BYTES` (64 KiB) | only when it falls back to `compact` | almost always |
| `full` | always inlined | no | you want the patch in context regardless of size |
| `compact` | omitted (`""`) | yes → `diff_artifact_path` (only when `diff_bytes > 0`) | large refactors; read the patch only if needed |
| `summary_only` | omitted (`""`) | no | you will review the worktree directly |

The response-mode fields are **additive** (no existing field was removed or retyped),
but the default `auto` mode is **not** fully behaviour-compatible with pre-response-mode
builds for large patches: above `GROK_MCP_INLINE_DIFF_MAX_BYTES`, `diff` is `""` and the
patch lives at `diff_artifact_path`. Pass `response_mode: "full"` to force the old
always-inline behaviour. Acceptable at 0.1.0 (pre-stable); `result_version` should bump
to `2` when a stable public API is declared.

`response_mode` is accepted by **all five tools** and is **per call** — `grok_continue`
does *not* inherit the previous call's mode; each continue defaults to `auto` again.

On read-only runs (`grok_analyze`, `grok_review`, `grok_debug` with `mode=read_only`)
the diff is normally empty, so `auto` resolves to `full` and the setting is a no-op.
It still applies to the diff that an `UNEXPECTED_MUTATION` would surface.

### Result fields

Present on **every** result, in all modes:

| Field | Meaning |
|-------|---------|
| `response_mode_requested` | what the caller asked for (`"auto"` when omitted) |
| `response_mode_effective` | `"full"` \| `"compact"` \| `"summary_only"` — what actually happened |
| `diff_included` | `true` only when `diff` holds the complete patch |
| `diff_bytes` | UTF-8 byte length of the **redacted** patch (regardless of `diff_included`) |
| `diff_sha256` | SHA-256 of the redacted patch that was returned and/or stored |
| `diff_stats` | `{ files_changed, insertions, deletions }` — parsed from the redacted patch, not from `git diff --stat` text |
| `diff_artifact_path` | absolute path to the stored patch, or `null` |
| `diff_complete` | `true` only when the patch represents the **whole** detected change. **Only a complete patch may be applied directly** |
| `diff_truncated` | `true` only when an opt-in absolute byte cap cut the patch body |
| `original_diff_bytes` | byte length before the cap; present only when `diff_truncated` |
| `next_actions` | short hints when the diff was not inlined or is incomplete; `[]` for a complete `full`, and always `[]` when `diff_bytes` is `0` (no artifact, nothing to follow up) |

With no changes the shape stays consistent: `diff_bytes: 0`, `diff_sha256` = the
empty-string digest, `diff_stats` all zeroes, `diff_artifact_path: null`,
`diff_complete: true`, `diff_truncated: false`, `next_actions: []`.

`diff_stats.files_changed` counts `diff --git` headers in the patch, so it can be
lower than `changed_files.length` when binary or oversized files were listed but
not fully patched.

#### `diff_complete` — when the patch is *not* the whole story

Size alone never makes a patch incomplete: an oversized diff moves to an artifact
intact, it is not cut. `diff_complete: false` means something was genuinely left
out, and the patch will not reproduce the change on its own:

| Cause | Warning |
|-------|---------|
| secret paths / hunks removed before the patch was assembled | `REDACTED_SECRET_PATHS` |
| untracked file above `GROK_MCP_MAX_UNTRACKED_FILE_BYTES` (never read into memory) | `UNTRACKED_TOO_LARGE` |
| binary file (tracked: git emits only a `Binary files … differ` marker; untracked: skipped by NUL sniff) or unreadable untracked file | `BINARY_SKIPPED` / `UNTRACKED_DIFF_FAILED` |
| an opt-in absolute cap cut the body | `DIFF_TRUNCATED` (with `diff_truncated: true`) |

Any of these also raise `DIFF_INCOMPLETE` and put a `Do not apply the patch as-is`
hint first in `next_actions` (when there is a non-empty patch to warn about).
Reconcile against `worktree_path` instead.

### Warnings

| Warning | Meaning |
|---------|---------|
| `DIFF_NOT_INLINED` | a non-empty patch was omitted from the response |
| `DIFF_ARTIFACT_CREATED` | the patch was written to `diff_artifact_path` |
| `DIFF_INCOMPLETE` | `diff_complete` is `false` — the patch omits part of the change; do not apply it as-is |
| `DIFF_TRUNCATED` | an opt-in `GROK_MCP_MAX_DIFF_BYTES` cap cut the body. Off by default |
| `DIFF_HARD_LIMIT_APPLIED` | `full` exceeded `GROK_MCP_INLINE_DIFF_HARD_MAX_BYTES` and was degraded to `compact` — the patch is **not** truncated, it is stored whole |
| `DIFF_ARTIFACT_WRITE_FAILED` | the artifact could not be written; the call degrades to `summary_only` rather than inlining a huge patch. `summary`, `changed_files`, `worktree_path`, `diff_stats` and `diff_sha256` are still returned |
| `DIFF_DISCARDED_NO_ARTIFACT` | no diff body, no artifact **and** `keep_worktree: false` — the patch is unrecoverable after this call. `next_actions` tells you how to re-run |

### Examples

**`auto` — normal use (just omit the field):**

```json
{
  "prompt": "Add retry with backoff to the HTTP client",
  "working_directory": "/ABS/PATH/TO/repo"
}
```

**`full` — force the patch into context:**

```json
{
  "prompt": "Fix the off-by-one in parseRange",
  "working_directory": "/ABS/PATH/TO/repo",
  "response_mode": "full"
}
```

**`compact` — big refactor, patch on disk:**

```json
{
  "prompt": "Migrate every callsite from the legacy logger",
  "working_directory": "/ABS/PATH/TO/repo",
  "response_mode": "compact"
}
```

Returns:

```json
{
  "result_version": 1,
  "summary": "Migrated 34 callsites…",
  "changed_files": ["src/a.ts", "src/b.ts"],
  "diff": "",
  "worktree_path": "/Users/you/.cache/codex-grok-mcp/worktrees/<hash>/<name>",
  "session_id": "…",
  "response_mode_requested": "compact",
  "response_mode_effective": "compact",
  "diff_included": false,
  "diff_bytes": 284913,
  "diff_sha256": "9f2b…",
  "diff_stats": { "files_changed": 34, "insertions": 512, "deletions": 388 },
  "diff_artifact_path": "/Users/you/.cache/codex-grok-mcp/diffs/<scope>/<uuid>.diff",
  "diff_complete": true,
  "diff_truncated": false,
  "next_actions": [
    "Inspect changed_files under worktree_path",
    "Read diff_artifact_path for the full redacted patch",
    "Run independent tests before applying changes"
  ],
  "warnings": ["DIFF_NOT_INLINED", "DIFF_ARTIFACT_CREATED"]
}
```

**`summary_only` — review in the worktree:**

```json
{
  "prompt": "Reformat the whole package",
  "working_directory": "/ABS/PATH/TO/repo",
  "response_mode": "summary_only"
}
```

No patch is returned and none is written — but the change is still fully
inspectable, because the isolated worktree is kept (`keep_worktree` defaults to
`true`). Diff it yourself:

```bash
git -C "$WORKTREE_PATH" --no-pager diff HEAD
```

> **Do not combine `summary_only` with `keep_worktree: false`.** That is the one
> combination where nothing survives the call: no diff body, no artifact, no
> worktree. The server flags it with `DIFF_DISCARDED_NO_ARTIFACT` and `next_actions`
> tells you how to re-run, but the work itself is gone. Use `compact` instead —
> its artifact outlives the reaped worktree.

### Inspecting a `compact` result (Codex / Claude Code)

1. Read `summary`, `changed_files` and `diff_stats` — usually enough to decide.
2. Need specific files? Read them straight out of `worktree_path`.
3. Need the whole patch? Read `diff_artifact_path` (already redacted, `0600`):

```bash
sed -n '1,200p' "$DIFF_ARTIFACT_PATH"
```

4. Verify integrity against `diff_sha256` before applying:

```bash
shasum -a 256 "$DIFF_ARTIFACT_PATH"
```

5. Check `diff_complete` first. If it is `true`, apply as usual:
   `git -C <original> apply "$DIFF_ARTIFACT_PATH"`. If it is `false` the patch is
   partial by design — copy the files you want out of `worktree_path` instead of
   applying it.
6. Continue the session at a different verbosity — `response_mode` is per call:

```json
{
  "prompt": "Also update the tests",
  "working_directory": "/ABS/PATH/TO/repo",
  "session_id": "…",
  "response_mode": "full"
}
```

### Diff artifacts

- Stored under the managed cache root: `~/.cache/codex-grok-mcp/diffs/<scope_digest>/<uuid>.diff`
  (`GROK_MCP_CACHE_DIR` moves it). `<scope_digest>` is a SHA-256 prefix of the session id
  (or worktree path / run id) — caller input is **never** concatenated into the path.
- Contains **only** the redacted patch: secret-path hunks are dropped and content
  regexes applied *before* the bytes are hashed or written. An unredacted diff is
  never written to a temp file.
- Written atomically: `O_CREAT|O_EXCL` temp file at mode `0600` → `fsync` → `rename`.
  Symlinked directories and pre-planted symlink targets are rejected or replaced,
  never followed out of the cache root.
- Each call writes a **new** UUID file. Continuing a session does not overwrite or
  delete earlier artifacts — they are retained until TTL GC so a parent agent can
  still read a patch it was handed several turns ago. The result always points at
  the newest one.
- GC'd at server start on the same TTL as worktrees (`GROK_MCP_WORKTREE_TTL_HOURS`),
  and only for validated managed artifacts: strictly under the realpath'd artifacts
  root, in a scope-digest directory, a regular file (never a symlink) with a managed
  name. Unknown paths, files outside the cache root, symlinks and their targets are
  never deleted.

## Requirements

- Node.js **≥ 20**
- `git` on `PATH`
- Grok Build CLI installed and authenticated (`grok login`)
- Codex CLI/IDE with MCP support

## Install

```bash
git clone <this-repo> && cd GPTtoGrok
npm install
npm run build
```

## Codex configuration

**Critical:** Codex defaults often use **~60s** per MCP tool. Grok implement/debug runs need much longer. Copy `examples/codex-config.toml` and set:

```toml
[mcp_servers.codex-grok]
command = "node"
args = ["/ABSOLUTE/PATH/TO/GPTtoGrok/dist/index.js"]
startup_timeout_sec = 30
tool_timeout_sec = 2400   # REQUIRED — 40 minutes
enabled = true
```

Without `tool_timeout_sec`, almost every real implement/debug call will be cancelled by Codex before Grok finishes.

Full example: [`examples/codex-config.toml`](examples/codex-config.toml).

## Claude Code configuration

This server works from **Claude Code** as well as Codex. Register it once:

```bash
# User scope: available in every project on this machine
claude mcp add codex-grok -s user -- node /ABSOLUTE/PATH/TO/GPTtoGrok/dist/index.js

# Or local scope: only the current project
# claude mcp add codex-grok -s local -- node /ABSOLUTE/PATH/TO/GPTtoGrok/dist/index.js
```

Claude Code defaults for MCP timeouts are far below `grok_implement`'s 30-minute server default. Raise them to match the Codex guidance:

| Variable | Role | Recommended |
|----------|------|-------------|
| `MCP_TOOL_TIMEOUT` | Per tool-call deadline (ms) | `2400000` (40 minutes) |
| `MCP_TIMEOUT` | Server startup / connect deadline (ms) | at least `30000` |

Example:

```bash
export MCP_TOOL_TIMEOUT=2400000
export MCP_TIMEOUT=30000
```

Without raising `MCP_TOOL_TIMEOUT`, long implement/debug runs are cut off by the host before Grok finishes.

Env snippet: [`examples/claude-code.env.example`](examples/claude-code.env.example).

### Host restarts after rebuild (all hosts)

The MCP server process is **spawned once** when the host connects. After `npm run build`, you must **restart the host** (or reconnect/reload the MCP server) before the new `dist/` code takes effect. Editing source or rebuilding alone does not hot-reload a running server.

## Isolation model (write tools)

Isolation is **best-effort**, not a hard OS guarantee.

**Default recipe:**

1. Snapshot original `git status`
2. `git worktree add` under `~/.cache/codex-grok-mcp/worktrees/<repo_hash>/<name>`
3. Spawn Grok with `--cwd <worktree_path>` (**no** `-w`) + `--sandbox workspace`
4. Deny Edit/Write on the original `repo_root` when the worktree is outside it
5. Collect worktree `diff` / `changed_files`; warn if the original tree became dirty

The original working tree is **not** the default edit target. Codex (or you) should apply results via `worktree_path` + `diff` + `changed_files` (`git apply`, file copy, or manual review).

Opt-in weaker path: `GROK_MCP_USE_GROK_WORKTREE=1` uses Grok’s `-w` with `sandbox=off`.

## Path safety

- `working_directory` must be **absolute**
- Resolved via `realpath` and checked against `GROK_MCP_ALLOWED_ROOTS` (default: home directory)
- Path traversal / null bytes rejected
- Recommend tightening roots, e.g. `GROK_MCP_ALLOWED_ROOTS=/Users/you/Documents:/Users/you/src`

## read_only policy

Effective `read_only` (default for `grok_analyze` / `grok_review`, optional on `grok_debug` / `grok_continue`) is **fail-closed**:

| Control | Behavior |
|---------|----------|
| **Tool allowlist** | Default `--tools read_file,grep,list_dir`. Caller `tools` may only **narrow** that list (intersection). Mutating/unknown IDs are dropped. Empty override or empty intersection falls back to the safe allowlist (never omits `--tools`, which would open all tools). |
| **Tool denylist** | Always includes mandatory IDs: `search_replace`, `write`, **both** shell names (`run_terminal_cmd`, `run_terminal_command`), and `Agent`. Caller `disallowed_tools` can only **add** more IDs; mandatory denies **cannot** be removed. |
| **Subagents** | Always `--no-subagents` in read_only — even if `allow_subagents: true`. |
| **Permission mode** | Forced `--permission-mode dontAsk`. Caller values `bypassPermissions`, `acceptEdits`, `auto`, and `default` are rejected (`GROK_MCP_INVALID_ARGS`). |
| **Sandbox** | Default `read-only`. Caller `sandbox=off` or `sandbox=workspace` is rejected. |
| **`test_command`** | Rejected in effective read_only. Retained only for effective `write_worktree` (runs after Grok in the worktree). |
| **Web** | Off unless `allow_web: true` (`--disable-web-search` otherwise). |

## Secrets

The server:

- Does not load project `.env` into the child environment
- Filters secret basenames (`.env`, `*.pem`, `id_rsa`, `auth.json`, …) from `changed_files`
- **Omits whole-file secret-path hunks** from result `diff` and from **review-injected** `git diff` / `--stat` (pathspecs + hunk/stat filters; warning `REDACTED_SECRET_PATHS` when result paths are dropped)
- Regex-redacts likely secrets in `summary`, stderr tails, and test output
- Passes Grok `--deny Read(...)` rules for common secret globs

Order is fixed and shared by **every** response mode: collect → drop secret-path
hunks → apply content redaction → measure bytes / hash → pick the response mode →
inline **or** write the artifact. `compact` re-uses the exact string `full` would
have inlined, so it cannot bypass redaction; no unredacted diff is ever written to
disk.

This is **best-effort DLP**, not perfect secret scanning.

## Security note: `test_command` runs outside Grok's sandbox

When the effective mode is `write_worktree`, optional `test_command` is executed by the MCP server on the **host** after Grok finishes:

- Spawn: `/bin/sh -c <test_command>` (non-login shell; profile is not sourced)
- **cwd** is the worktree (or effective cwd), which Grok may have modified arbitrarily
- Runs with a scrubbed environment on the host — **not** under Grok’s `--sandbox workspace`

A generated `package.json`, test file, or script in the worktree is therefore executed with the user’s host `PATH` and privileges. **Only pass `test_command` for prompts and repositories you trust.** It is rejected entirely when the effective mode is `read_only` (`GROK_MCP_INVALID_ARGS`).

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `GROK_MCP_GROK_BIN` | `~/.grok/bin/grok` or `PATH` | Grok binary |
| `GROK_MCP_ALLOWED_ROOTS` | `$HOME` | Colon-separated absolute roots |
| `GROK_MCP_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` (stderr JSON) |
| `GROK_MCP_MAX_CONCURRENT` | `2` | Parallel Grok runs |
| `GROK_MCP_SANDBOX` | `workspace` | Write-mode sandbox profile |
| `GROK_MCP_USE_GROK_WORKTREE` | `0` | Opt-in Grok `-w` path |
| `GROK_MCP_FAIL_ON_ORIGINAL_DIRTY` | `0` | Error if original tree mutates |
| `GROK_MCP_CACHE_DIR` | `~/.cache/codex-grok-mcp` | Sessions + worktrees + diff artifacts |
| `GROK_MCP_WORKTREE_TTL_HOURS` | `72` | TTL for worktree **and** diff-artifact GC (start-up only) |
| `GROK_MCP_INLINE_DIFF_MAX_BYTES` | `65536` | `response_mode: "auto"` inlines the diff while it is ≤ this many bytes; above it falls back to `compact`. `0` = never inline |
| `GROK_MCP_INLINE_DIFF_HARD_MAX_BYTES` | `1048576` | Absolute inline ceiling. A larger diff degrades to `compact` even for `response_mode: "full"` (warning `DIFF_HARD_LIMIT_APPLIED`) |
| `GROK_MCP_MAX_DIFF_BYTES` | `0` *(unlimited)* | Opt-in absolute cap on the patch body itself. `0` disables truncation entirely — oversized diffs go to an artifact whole. A non-zero value cuts the patch and sets `diff_truncated: true` / `diff_complete: false` / `original_diff_bytes`. Max 512 MiB |

> **Changed in this release.** `GROK_MCP_MAX_DIFF_BYTES` used to default to 1 MiB
> and truncate during diff collection — *before* `response_mode` ran, so even
> `compact` artifacts held a silently cut patch. It is now off by default and, if
> you set it, applies in the response-mode stage and is reported honestly. Since
> `git`'s output is fully buffered in memory either way, the old cap bought no
> peak-memory saving; use `GROK_MCP_MAX_UNTRACKED_FILE_BYTES` (a pre-read cap) for
> that.

The inline byte limits accept non-negative integers up to 16 MiB. Anything else —
negative, `NaN`, fractional, non-numeric, or over the ceiling — is **ignored**: the
default is used and a warning is written to **stderr** at startup.

## Consumer workflow (Codex)

After `grok_implement` / `grok_debug`:

1. Read `worktree_path`, `changed_files`, `diff`
2. If `diff_included` is `false`, get the patch from `diff_artifact_path` or the worktree — see [Inspecting a `compact` result](#inspecting-a-compact-result-codex--claude-code)
3. Review the patch
4. Apply with `git -C <original> apply` or copy files from the worktree
5. If `warnings` includes `ORIGINAL_TREE_DIRTY`, stop auto-apply and investigate
6. Iterate with `grok_continue` + `session_id` (does not create a new worktree)

### `grok_continue` (write resume)

Write-mode continue is **strict**. It requires:

1. A **stored** MCP session record for `session_id` (unmapped write sessions are rejected)
2. That record’s mode is `write_worktree` and **`managed: true`** (server-created worktree)
3. Stored `worktree_path` exists, is under the managed cache root, is **registered** via `git worktree list` for the same repo as `working_directory`, and is not the original repo root
4. Optional caller `worktree_path` must **exactly match** the stored path (realpath); mismatches → `GROK_MCP_WORKTREE_INVALID`

Never passes `-w` on continue. Missing worktree → `GROK_MCP_WORKTREE_MISSING` (or read_only downgrade only when `allow_missing_worktree` is set **without** explicit `mode=write_worktree`).

### Worktree GC

TTL GC runs **at server start only** (not after tool calls) and **only removes validated managed worktrees**:

- Path must be absolute, realpath’d, **strictly under** `~/.cache/codex-grok-mcp/worktrees` (or `GROK_MCP_CACHE_DIR`)
- Must not be the original repo root
- Must be registered to that repo via `git worktree list`
- Session entries must have `managed === true` (pending worktrees are always server-created)

Untrusted, unregistered, or outside-root paths are **never** deleted — even if `sessions.json` is malicious.

Diff artifacts are GC'd in the same pass on the same TTL, with the equivalent
validation (see [Diff artifacts](#diff-artifacts)).

## Development

```bash
npm test          # unit + integration (mock grok)
npm run build
npm run typecheck
npm run dev       # stdio server (for manual MCP attach)
```

Design: [`docs/design-codex-grok-mcp.md`](docs/design-codex-grok-mcp.md)  
Agent notes: [`AGENTS.md`](AGENTS.md)

## Error shapes

Tool failures returned from our handlers use a frozen JSON envelope:

```json
{
  "error_version": 1,
  "code": "GROK_MCP_INVALID_ARGS",
  "message": "…",
  "details": {}
}
```

Including schema failures from the handler’s explicit Zod `.parse` (converted to `GROK_MCP_INVALID_ARGS`). Path / mode / runtime errors use the same shape.

**Residual case:** the MCP SDK may validate the registered `inputSchema` *before* the handler runs. If the SDK rejects first, the host may see a raw JSON-RPC `-32602 Input validation error: …` instead of the envelope. That path is outside this server’s control.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tool cancelled after ~60s | Set `tool_timeout_sec = 2400` in Codex MCP config, **or** `MCP_TOOL_TIMEOUT=2400000` for Claude Code |
| Changes after `npm run build` not visible | Restart the host / reconnect the MCP server (process is not hot-reloaded) |
| `GROK_MCP_GROK_NOT_FOUND` | Install Grok CLI; set `GROK_MCP_GROK_BIN` |
| `GROK_MCP_NOT_A_GIT_REPO` | Init git, or use `grok_analyze` (read-only) |
| `GROK_MCP_PATH_NOT_ALLOWED` | Expand `GROK_MCP_ALLOWED_ROOTS` |
| Orphan worktrees | `git worktree list`; remove only managed paths under `~/.cache/codex-grok-mcp/worktrees` (GC already refuses non-managed paths) |
| Resume fails | Pass exact `session_id` from prior result; write continue needs stored **managed** same-repo registered worktree |
| `test_command` rejected | Only valid in effective `write_worktree`; omit for analyze/review/read_only |
| `permission_mode` / `sandbox` rejected | read_only forbids unsafe overrides (`bypassPermissions`, `off`, `workspace`, …) |
| `diff` came back empty | Check `diff_included` / `response_mode_effective`. Read `diff_artifact_path`, or re-run with `response_mode: "full"` |
| `DIFF_ARTIFACT_WRITE_FAILED` | Cache root not writable — check `GROK_MCP_CACHE_DIR` permissions and free space; the result degraded to `summary_only` |
| Diff artifacts piling up | They expire on `GROK_MCP_WORKTREE_TTL_HOURS` at server start; delete `~/.cache/codex-grok-mcp/diffs` to reclaim immediately |
| Raw `-32602` validation error | SDK rejected args before our handler; fix the field named in the message (envelope applies only after the handler runs) |

## License

MIT
