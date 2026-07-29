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
- `changed_files` — relative paths
- `diff` — apply-friendly patch (untracked files included)
- `tests` — optional `test_command` result
- `session_id` — for `grok_continue`
- `worktree_path` — isolated tree for write modes
- `warnings` — e.g. `ORIGINAL_TREE_DIRTY`, `UNEXPECTED_MUTATION`

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

## Secrets

The server:

- Does not load project `.env` into the child environment
- Filters secret basenames (`.env`, `*.pem`, `id_rsa`, `auth.json`, …) from `changed_files` / diffs
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
| Orphan worktrees | `git worktree list`; remove under `~/.cache/codex-grok-mcp/worktrees` |
| Resume fails | Pass exact `session_id` from prior result; check worktree still exists |

## License

MIT
