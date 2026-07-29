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
- `diff` — apply-friendly patch (untracked files included; **secret-path hunks omitted**)
- `tests` — optional `test_command` result (**write_worktree only**; rejected in effective `read_only`)
- `session_id` — for `grok_continue`
- `worktree_path` — isolated tree for write modes
- `warnings` — e.g. `ORIGINAL_TREE_DIRTY`, `UNEXPECTED_MUTATION`, `REDACTED_SECRET_PATHS`

### Shared optional inputs

| Field | Notes |
|-------|--------|
| `reasoning_effort` | Public enum: `none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`. Mapped 1:1 to Grok CLI `--reasoning-effort`. |
| `model` | Passed as `-m`. For deeper analysis on current Grok, prefer **Grok 4.5** with `reasoning_effort: "high"`. |
| `test_command` | Allowed only when the **effective** mode is `write_worktree`. Effective `read_only` → `GROK_MCP_INVALID_ARGS`. |
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

This is **best-effort DLP**, not perfect secret scanning.

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
| `GROK_MCP_CACHE_DIR` | `~/.cache/codex-grok-mcp` | Sessions + worktrees |

## Consumer workflow (Codex)

After `grok_implement` / `grok_debug`:

1. Read `worktree_path`, `changed_files`, `diff`
2. Review the patch
3. Apply with `git -C <original> apply` or copy files from the worktree
4. If `warnings` includes `ORIGINAL_TREE_DIRTY`, stop auto-apply and investigate
5. Iterate with `grok_continue` + `session_id` (does not create a new worktree)

### `grok_continue` (write resume)

Write-mode continue is **strict**. It requires:

1. A **stored** MCP session record for `session_id` (unmapped write sessions are rejected)
2. That record’s mode is `write_worktree` and **`managed: true`** (server-created worktree)
3. Stored `worktree_path` exists, is under the managed cache root, is **registered** via `git worktree list` for the same repo as `working_directory`, and is not the original repo root
4. Optional caller `worktree_path` must **exactly match** the stored path (realpath); mismatches → `GROK_MCP_WORKTREE_INVALID`

Never passes `-w` on continue. Missing worktree → `GROK_MCP_WORKTREE_MISSING` (or read_only downgrade only when `allow_missing_worktree` is set **without** explicit `mode=write_worktree`).

### Worktree GC

TTL GC (server start / after calls) **only removes validated managed worktrees**:

- Path must be absolute, realpath’d, **strictly under** `~/.cache/codex-grok-mcp/worktrees` (or `GROK_MCP_CACHE_DIR`)
- Must not be the original repo root
- Must be registered to that repo via `git worktree list`
- Session entries must have `managed === true` (pending worktrees are always server-created)

Untrusted, unregistered, or outside-root paths are **never** deleted — even if `sessions.json` is malicious.

## Development

```bash
npm test          # unit + integration (mock grok)
npm run build
npm run typecheck
npm run dev       # stdio server (for manual MCP attach)
```

Design: [`docs/design-codex-grok-mcp.md`](docs/design-codex-grok-mcp.md)  
Agent notes: [`AGENTS.md`](AGENTS.md)

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tool cancelled after ~60s | Set `tool_timeout_sec = 2400` in Codex MCP config |
| `GROK_MCP_GROK_NOT_FOUND` | Install Grok CLI; set `GROK_MCP_GROK_BIN` |
| `GROK_MCP_NOT_A_GIT_REPO` | Init git, or use `grok_analyze` (read-only) |
| `GROK_MCP_PATH_NOT_ALLOWED` | Expand `GROK_MCP_ALLOWED_ROOTS` |
| Orphan worktrees | `git worktree list`; remove only managed paths under `~/.cache/codex-grok-mcp/worktrees` (GC already refuses non-managed paths) |
| Resume fails | Pass exact `session_id` from prior result; write continue needs stored **managed** same-repo registered worktree |
| `test_command` rejected | Only valid in effective `write_worktree`; omit for analyze/review/read_only |
| `permission_mode` / `sandbox` rejected | read_only forbids unsafe overrides (`bypassPermissions`, `off`, `workspace`, …) |

## License

MIT
