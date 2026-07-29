# codex-grok-mcp

[![CI](https://github.com/sasanokusa/GPTtoGrok/actions/workflows/ci.yml/badge.svg)](https://github.com/sasanokusa/GPTtoGrok/actions/workflows/ci.yml)

**Codex CLI** / **Codex IDE** からコーディング作業を **[Grok Build](https://grok.x.ai/)**（ヘッドレス CLI）へ委譲するための、ローカル **stdio MCP サーバー**です。

```text
Codex  --stdio MCP-->  codex-grok-mcp  --spawn-->  grok --no-auto-update -p … --output-format streaming-json
```

## ツール

| ツール | 既定モード | 用途 |
|------|--------------|---------|
| `grok_analyze` | `read_only` | コードベースの調査・説明 |
| `grok_implement` | `write_worktree` | **隔離された git worktree** 内で機能追加・修正を実装 |
| `grok_review` | `read_only` | 変更のレビュー（サーバーが `base_ref` との `git diff` を注入） |
| `grok_debug` | `write_worktree` | デバッグ・修正（`mode=read_only` も指定可） |
| `grok_continue` | 継承 | 前回セッションの再開（`--resume`） |

成功した呼び出しはすべて、バージョン付き JSON（`result_version: 1`）を返します。

- `summary` — エージェントのテキスト（redaction 済み）
- `changed_files` — 相対パス（シークレットの basename は除外）
- `diff` — apply 可能な patch（untracked ファイルを含む。**シークレットパスの hunk は除外**）。`diff_included` が `false` のときは空文字列 — [レスポンスモード](#レスポンスモード)を参照
- `tests` — 任意の `test_command` の結果（**write_worktree のみ**。実効 `read_only` では拒否）。結果別の予算でログが切られた場合は `output_truncated` / `original_output_bytes` を含む — [テスト出力の上限](#テスト出力の上限)を参照
- `session_id` — `grok_continue` 用
- `worktree_path` — write モードでの隔離ツリー
- `warnings` — 例: `ORIGINAL_TREE_DIRTY`、`UNEXPECTED_MUTATION`、`REDACTED_SECRET_PATHS`
- `response_mode_requested` / `response_mode_effective`、`diff_included`、`diff_bytes`、`diff_sha256`、`diff_stats`、`diff_artifact_path`、`next_actions` — [レスポンスモード](#レスポンスモード)を参照

### 共通のオプション入力

| フィールド | 備考 |
|-------|--------|
| `reasoning_effort` | 公開 enum: `none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`。Grok CLI の `--reasoning-effort` に 1:1 で対応。 |
| `model` | `-m` として渡されます。現行 Grok で深い解析をしたい場合は **Grok 4.5** + `reasoning_effort: "high"` を推奨。 |
| `test_command` | **実効**モードが `write_worktree` のときのみ許可。実効 `read_only` では `GROK_MCP_INVALID_ARGS`。 |
| `response_mode` | `auto`（既定）\| `full` \| `compact` \| `summary_only`。MCP レスポンスが運ぶ **diff** の量を制御します（テスト出力や summary は対象外）。[レスポンスモード](#レスポンスモード)を参照。 |
| `tools` / `disallowed_tools` | 後述の [read_only ポリシー](#read_only-ポリシー)を参照。 |
| `permission_mode` / `sandbox` / `allow_subagents` | `read_only` では制限されます（後述）。 |

例（Grok 4.5・high effort で analyze）:

```json
{
  "prompt": "Explain how path allowlisting works",
  "working_directory": "/ABS/PATH/TO/repo",
  "model": "grok-4.5",
  "reasoning_effort": "high"
}
```

## レスポンスモード

大きな Grok の diff を毎回そのまま返すと、MCP のレスポンスサイズと親モデルのコンテキストを消費します。`response_mode` は、**patch** をどれだけ Codex / Claude Code へ返すかを制御します。**分離・redaction・セッション継続性を一切弱めません。**

**適用範囲。** `response_mode` が制御するのは `diff` フィールド（とその artifact 転送）**のみ**です。`tests.output` と `summary` はそれぞれ独立した上限を持ち、`compact` / `summary_only` によって縮小されることは**ありません**。

| モード | `diff` 本文 | ディスク上の artifact | 使いどころ |
|------|-------------|------------------|----------|
| `auto` *(既定)* | `GROK_MCP_INLINE_DIFF_MAX_BYTES`（64 KiB）以下なら inline | `compact` へフォールバックしたときのみ | ほぼ常にこれ |
| `full` | 常に inline | なし | サイズに関係なく patch をコンテキストに入れたいとき |
| `compact` | 省略（`""`） | あり → `diff_artifact_path`（`diff_bytes > 0` のときのみ） | 大規模リファクタ。必要なときだけ patch を読む |
| `summary_only` | 省略（`""`） | なし | worktree を直接レビューするとき |

レスポンスモード関連のフィールドは**追加のみ**です（既存フィールドの削除・型変更はありません）。ただし既定の `auto` は、レスポンスモード導入前のビルドと大きな patch について**完全な挙動互換ではありません**。`GROK_MCP_INLINE_DIFF_MAX_BYTES` を超えると `diff` は `""` になり、patch は `diff_artifact_path` に置かれます。従来の常時 inline 挙動が必要なら `response_mode: "full"` を渡してください。0.1.0（安定版前）では許容範囲とし、安定 API を宣言する時点で `result_version` を `2` へ上げる想定です。

`response_mode` は**5つのツールすべて**が受け付け、**呼び出しごと**に有効です。`grok_continue` は前回のモードを継承せず、各 continue で既定の `auto` に戻ります。

read-only 実行（`grok_analyze`、`grok_review`、`mode=read_only` の `grok_debug`）では diff は通常空なので、`auto` は `full` に解決され設定は実質無効です。ただし `UNEXPECTED_MUTATION` が表面化させる diff には引き続き適用されます。

### 結果フィールド

すべてのモードで、**すべての**結果に存在します。

| フィールド | 意味 |
|-------|---------|
| `response_mode_requested` | 呼び出し側が要求した値（省略時は `"auto"`） |
| `response_mode_effective` | `"full"` \| `"compact"` \| `"summary_only"` — 実際に適用された結果 |
| `diff_included` | `diff` に patch 本文が入っているときのみ `true` |
| `diff_bytes` | **redaction 済み** patch の UTF-8 バイト長（`diff_included` とは独立） |
| `diff_sha256` | 返却および／または保存された redaction 済み patch の SHA-256 |
| `diff_stats` | `{ files_changed, insertions, deletions }` — `git diff --stat` の文字列ではなく redaction 済み patch から解析 |
| `diff_artifact_path` | 保存された patch の絶対パス、または `null` |
| `diff_complete` | patch が検出された変更**全体**を表すときのみ `true`。**完全な patch だけが直接 apply 可能です** |
| `diff_truncated` | 任意設定の絶対上限が patch 本文を切ったときのみ `true` |
| `original_diff_bytes` | 上限適用前のバイト長。`diff_truncated` のときのみ存在 |
| `next_actions` | diff が inline されなかった、または不完全なときの短いヒント。完全な `full` では `[]`、`diff_bytes` が `0` のときも常に `[]`（artifact もなく、追う先がないため） |

変更が無い場合も形は一貫します: `diff_bytes: 0`、`diff_sha256` = 空文字列のダイジェスト、`diff_stats` はすべてゼロ、`diff_artifact_path: null`、`diff_complete: true`、`diff_truncated: false`、`next_actions: []`。

`diff_stats.files_changed` は patch 内の `diff --git` ヘッダ数を数えるため、バイナリや過大なファイルが列挙だけされて patch 化されなかった場合、`changed_files.length` より小さくなることがあります。

### テスト出力の上限

任意の `test_command` の出力は、`response_mode` ではなく**実行結果**によって上限が決まります。

| 結果 | 予算の環境変数 | 既定 |
|---------|------------|---------|
| `exit_code === 0`（成功） | `GROK_MCP_MAX_TEST_OUTPUT_SUCCESS_BYTES` | 4 KiB |
| 非ゼロ（失敗） | `GROK_MCP_MAX_TEST_OUTPUT_BYTES` | 64 KiB |

成功したランはほぼノイズ（`✓` の行が数千）ですが、失敗したランこそ呼び出し側が必要とするものです。`compact` や `summary_only` でも**失敗時は完全な予算のまま**返します。バイト数を節約するためにテスト失敗の理由を隠すのは筋が悪いためです。

予算がログを切る場合、**末尾**を保持し（失敗サマリは末尾にあるため）、先頭に `... [test output truncated] ` マーカーを付け、結果に次を報告します。

| フィールド | 意味 |
|-------|---------|
| `tests.output_truncated` | 返却された `output` が切られたとき `true` |
| `tests.original_output_bytes` | 切る前のバイト長。切られたときのみ存在 |

未実行のテスト（`tests.ran: false`）は `output_truncated: false` となり、元サイズは省略されます。

#### `diff_complete` — patch が変更全体を表さない場合

サイズだけで patch が不完全になることはありません。過大な diff は切られるのではなく、そのまま artifact へ移されます。`diff_complete: false` は、**実際に何かが欠落しており、その patch だけでは変更を再現できない**ことを意味します。

| 原因 | 警告 |
|-------|---------|
| patch 組み立て前にシークレットパス／hunk を除外した | `REDACTED_SECRET_PATHS` |
| 内容 redaction が patch 内のバイトを書き換えた（`[REDACTED]`） | `REDACTED_SECRET_CONTENT` |
| `GROK_MCP_MAX_UNTRACKED_FILE_BYTES` を超える untracked ファイル（メモリへ読み込まれません） | `UNTRACKED_TOO_LARGE` |
| バイナリファイル（tracked: git は `Binary files … differ` マーカーしか出しません。untracked: NUL 検出でスキップ）または読めない untracked ファイル | `BINARY_SKIPPED` / `UNTRACKED_DIFF_FAILED` |
| 任意設定の絶対上限が本文を切った | `DIFF_TRUNCATED`（`diff_truncated: true` を伴う） |

いずれの場合も `DIFF_INCOMPLETE` を出し、`next_actions` の先頭に `Do not apply the patch as-is` のヒントを置きます（警告すべき非空の patch がある場合）。そのまま apply せず、`worktree_path` と突き合わせてください。

**内容 redaction は意図的に広く、fail-closed です。** パターンは本物の鍵だけでなく `token: someIdentifier` や `secret = configValue` のような記述にもマッチするため、`diff_complete: false` + `REDACTED_SECRET_CONTENT` はごく普通のコード diff でも頻繁に出ます。これは意図した挙動です。このフラグは*「バイトが書き換わっているので `git apply` を盲目的に実行せず、`worktree_path` と突き合わせろ」*という意味です。ノイズを減らすためにパターンを狭めることはしません（AGENTS.md #2）。

### 警告

| 警告 | 意味 |
|---------|---------|
| `DIFF_NOT_INLINED` | 非空の patch がレスポンスから省略された |
| `DIFF_ARTIFACT_CREATED` | patch が `diff_artifact_path` へ書き出された |
| `DIFF_INCOMPLETE` | `diff_complete` が `false` — patch は変更の一部を欠いている。そのまま apply しないこと |
| `DIFF_TRUNCATED` | 任意設定の `GROK_MCP_MAX_DIFF_BYTES` 上限が本文を切った。既定では無効 |
| `DIFF_HARD_LIMIT_APPLIED` | `full` が `GROK_MCP_INLINE_DIFF_HARD_MAX_BYTES` を超えたため `compact` へ降格。patch は切られておらず、**丸ごと**保存されている |
| `DIFF_ARTIFACT_WRITE_FAILED` | artifact を書けなかったため、巨大な patch を inline する代わりに `summary_only` へ縮退。`summary`、`changed_files`、`worktree_path`、`diff_stats`、`diff_sha256` は返る |
| `DIFF_DISCARDED_NO_ARTIFACT` | diff 本文も artifact も無く、**かつ** `keep_worktree: false` — この呼び出し後 patch は復旧不能。再実行方法は `next_actions` を参照 |
| `REDACTED_SECRET_PATHS` | シークレットパスのファイル／hunk が組み立て済み patch から除外された |
| `REDACTED_SECRET_CONTENT` | 内容 redaction の正規表現が patch 内のバイトを書き換えた（`[REDACTED]`）。本文はもはや忠実な apply 可能 patch ではない。広いパターンにより無害なコードでも発火しうる（設計上の fail-closed） |

### 使用例

**`auto` — 通常利用（フィールドを省略するだけ）:**

```json
{
  "prompt": "Add retry with backoff to the HTTP client",
  "working_directory": "/ABS/PATH/TO/repo"
}
```

**`full` — patch を強制的にコンテキストへ入れる:**

```json
{
  "prompt": "Fix the off-by-one in parseRange",
  "working_directory": "/ABS/PATH/TO/repo",
  "response_mode": "full"
}
```

**`compact` — 大規模リファクタ、patch はディスクへ:**

```json
{
  "prompt": "Migrate every callsite from the legacy logger",
  "working_directory": "/ABS/PATH/TO/repo",
  "response_mode": "compact"
}
```

返却例:

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

**`summary_only` — worktree でレビューする:**

```json
{
  "prompt": "Reformat the whole package",
  "working_directory": "/ABS/PATH/TO/repo",
  "response_mode": "summary_only"
}
```

patch は返されず、書き出されもしません。それでも変更は完全に確認可能です。隔離 worktree が保持されるためです（`keep_worktree` の既定は `true`）。自分で diff を取ってください:

```bash
git -C "$WORKTREE_PATH" --no-pager diff HEAD
```

> **`summary_only` と `keep_worktree: false` を組み合わせないでください。** これは呼び出し後に何も残らない唯一の組み合わせです（diff 本文なし・artifact なし・worktree なし）。サーバーは `DIFF_DISCARDED_NO_ARTIFACT` で警告し `next_actions` が再実行方法を示しますが、作業そのものは失われます。代わりに `compact` を使ってください。その artifact は破棄された worktree より長く残ります。

### `compact` 結果を確認する手順

Codex / Claude Code からの確認手順です。

1. `summary`、`changed_files`、`diff_stats` を読む — たいていはこれで判断できます。
2. 特定のファイルが見たい場合は `worktree_path` から直接読みます。
3. patch 全体が必要な場合は `diff_artifact_path` を読みます（redaction 済み、`0600`）:

```bash
sed -n '1,200p' "$DIFF_ARTIFACT_PATH"
```

4. apply 前に `diff_sha256` と突き合わせて完全性を検証します:

```bash
shasum -a 256 "$DIFF_ARTIFACT_PATH"
```

5. **まず `diff_complete` を確認します。** `true` なら通常どおり `git -C <original> apply "$DIFF_ARTIFACT_PATH"` で適用できます。`false` の場合、その patch は設計上部分的なものなので、apply せずに `worktree_path` から必要なファイルをコピーしてください。
6. 別の詳細度でセッションを継続します（`response_mode` は呼び出しごと）:

```json
{
  "prompt": "Also update the tests",
  "working_directory": "/ABS/PATH/TO/repo",
  "session_id": "…",
  "response_mode": "full"
}
```

### diff artifact

- 管理下のキャッシュルートに保存されます: `~/.cache/codex-grok-mcp/diffs/<scope_digest>/<uuid>.diff`（`GROK_MCP_CACHE_DIR` で移動可能）。`<scope_digest>` は session id（または worktree パス / run id）の SHA-256 プレフィックスで、呼び出し側の入力がパスへ直接連結されることは**ありません**。
- **redaction 済みの patch のみ**を格納します。シークレットパスの hunk 除外と内容正規表現の適用は、バイトをハッシュ化・書き出しする*前*に完了します。未 redaction の diff が一時ファイルへ書かれることはありません。
- アトミックに書き込みます: `O_CREAT|O_EXCL` の一時ファイルをモード `0600` で作成 → `fsync` → `rename`。シンボリックリンクのディレクトリや事前に仕掛けられた symlink 先は拒否または置換され、キャッシュルート外へ追従することはありません。
- 呼び出しごとに**新しい** UUID ファイルを書きます。セッションを継続しても以前の artifact を上書き・削除しません。親エージェントが数ターン前に受け取った patch を後から読めるよう、TTL GC まで保持されます。結果は常に最新のものを指します。
- worktree と同じ TTL（`GROK_MCP_WORKTREE_TTL_HOURS`）でサーバー起動時に GC されます。削除対象は検証済みの管理下 artifact のみです（realpath 解決した artifacts ルートの厳密に下、scope digest ディレクトリ内、シンボリックリンクではない通常ファイル、管理下の命名規則）。不明なパス、キャッシュルート外のファイル、シンボリックリンクとその参照先は決して削除されません。

## 必要環境

- Node.js **20 以上**
- `PATH` 上の `git`
- Grok Build CLI がインストール済みで認証済み（`grok login`）
- MCP 対応の Codex CLI / IDE

## インストール

```bash
git clone <this-repo> && cd GPTtoGrok
npm install
npm run build
```

## Codex の設定

**重要:** Codex の既定は MCP ツールあたり **約60秒**であることが多く、Grok の implement / debug 実行にはまったく足りません。`examples/codex-config.toml` をコピーして次を設定してください。

```toml
[mcp_servers.codex-grok]
command = "node"
args = ["/ABSOLUTE/PATH/TO/GPTtoGrok/dist/index.js"]
startup_timeout_sec = 30
tool_timeout_sec = 2400   # 必須 — 40分
enabled = true
```

`tool_timeout_sec` が無いと、実運用の implement / debug 呼び出しはほぼ確実に Grok の完了前に Codex 側でキャンセルされます。

完全な例: [`examples/codex-config.toml`](examples/codex-config.toml)

## Claude Code の設定

このサーバーは Codex だけでなく **Claude Code** からも利用できます。一度登録すれば OK です。

```bash
# user スコープ: このマシンの全プロジェクトで利用可能
claude mcp add codex-grok -s user -- node /ABSOLUTE/PATH/TO/GPTtoGrok/dist/index.js

# local スコープ: 現在のプロジェクトのみ
# claude mcp add codex-grok -s local -- node /ABSOLUTE/PATH/TO/GPTtoGrok/dist/index.js
```

Claude Code の MCP タイムアウト既定値は、`grok_implement` のサーバー既定（30分）を大きく下回ります。Codex と同様に引き上げてください。

| 変数 | 役割 | 推奨値 |
|----------|------|-------------|
| `MCP_TOOL_TIMEOUT` | ツール呼び出しごとの期限（ms） | `2400000`（40分） |
| `MCP_TIMEOUT` | サーバー起動・接続の期限（ms） | 最低 `30000` |

例:

```bash
export MCP_TOOL_TIMEOUT=2400000
export MCP_TIMEOUT=30000
```

`MCP_TOOL_TIMEOUT` を上げないと、長時間の implement / debug 実行は Grok の完了前にホスト側で打ち切られます。

環境変数のサンプル: [`examples/claude-code.env.example`](examples/claude-code.env.example)

### リビルド後はホストの再起動が必要（全ホスト共通）

MCP サーバープロセスは、ホストが接続した時点で**一度だけ** spawn されます。`npm run build` の後、新しい `dist/` のコードを反映するには**ホストの再起動**（または MCP サーバーの再接続・再読み込み）が必要です。ソースの編集やリビルドだけでは、稼働中のサーバーはホットリロードされません。

## 分離モデル（write 系ツール）

分離は **best-effort** であり、OS レベルの強い保証ではありません。

**既定の手順:**

1. 元リポジトリの `git status` をスナップショット
2. `~/.cache/codex-grok-mcp/worktrees/<repo_hash>/<name>` に `git worktree add`
3. `--cwd <worktree_path>`（**`-w` は使わない**）+ `--sandbox workspace` で Grok を spawn
4. worktree が元リポジトリの外にある場合、元の `repo_root` への Edit / Write を deny
5. worktree の `diff` / `changed_files` を収集。元ツリーが dirty になっていれば警告

元の作業ツリーは既定の編集対象では**ありません**。Codex（またはあなた）は `worktree_path` + `diff` + `changed_files` 経由で結果を適用してください（`git apply`、ファイルコピー、手動レビューなど）。

より弱いオプトイン経路: `GROK_MCP_USE_GROK_WORKTREE=1` は Grok の `-w` を `sandbox=off` で使います。

## パス安全性

- `working_directory` は**絶対パス**必須
- `realpath` で解決し `GROK_MCP_ALLOWED_ROOTS`（既定: ホームディレクトリ）と照合
- パストラバーサル / NULバイトは拒否
- ルートは絞ることを推奨。例: `GROK_MCP_ALLOWED_ROOTS=/Users/you/Documents:/Users/you/src`

## read_only ポリシー

実効 `read_only`（`grok_analyze` / `grok_review` の既定。`grok_debug` / `grok_continue` では任意）は **fail-closed** です。

| 制御 | 挙動 |
|---------|----------|
| **ツール allowlist** | 既定は `--tools read_file,grep,list_dir`。呼び出し側の `tools` はこのリストを**狭める**ことしかできません（積集合）。変更系・不明な ID は破棄されます。空の上書きや空の積集合は安全な allowlist にフォールバックします（`--tools` を省略すると全ツールが開いてしまうため、決して省略しません）。 |
| **ツール denylist** | 必須 ID を常に含みます: `search_replace`、`write`、シェル系の**両方**の名前（`run_terminal_cmd`、`run_terminal_command`）、`Agent`。呼び出し側の `disallowed_tools` は ID を**追加**できるだけで、必須の deny を**外すことはできません**。 |
| **サブエージェント** | read_only では `allow_subagents: true` でも常に `--no-subagents`。 |
| **パーミッションモード** | `--permission-mode dontAsk` を強制。呼び出し側の `bypassPermissions`、`acceptEdits`、`auto`、`default` は拒否（`GROK_MCP_INVALID_ARGS`）。 |
| **サンドボックス** | 既定 `read-only`。呼び出し側の `sandbox=off` / `sandbox=workspace` は拒否。 |
| **`test_command`** | 実効 read_only では拒否。実効 `write_worktree` のときのみ保持（Grok の後に worktree 内で実行）。 |
| **Web** | `allow_web: true` でない限り無効（それ以外は `--disable-web-search`）。 |

## シークレット

このサーバーは:

- プロジェクトの `.env` を子プロセスの環境へ読み込みません
- シークレットの basename（`.env`、`*.pem`、`id_rsa`、`auth.json` など）を `changed_files` から除外します
- 結果の `diff` および **review が注入する** `git diff` / `--stat` から、**シークレットパスのファイル単位 hunk を除外**します（pathspec + hunk/stat フィルタ。結果のパスが落ちた場合は `REDACTED_SECRET_PATHS` を警告）
- 結果の `diff`、`summary`、stderr 末尾、テスト出力に対し、シークレットらしき文字列を正規表現で redaction します。**結果**の patch が書き換わった場合は `diff_complete: false` + `REDACTED_SECRET_CONTENT` も設定します（パターンは広いまま。fail-closed であり、普通の識別子にも反応しえます）
- 一般的なシークレット glob に対して Grok へ `--deny Read(...)` ルールを渡します

順序は固定で、**すべての**レスポンスモードで共通です: 収集 → シークレットパス hunk の除外 → 内容 redaction → バイト数・ハッシュの計測 → レスポンスモードの決定 → inline **または** artifact 書き出し。`compact` は `full` が inline したはずの文字列をそのまま再利用するため、redaction を迂回できません。未 redaction の diff がディスクへ書かれることはありません。

これは **best-effort な DLP** であり、完全なシークレットスキャンではありません。

## セキュリティ注意: `test_command` は Grok のサンドボックス外で実行される

実効モードが `write_worktree` のとき、任意の `test_command` は Grok 完了後に MCP サーバーが**ホスト上で**実行します。

- 起動: `/bin/sh -c <test_command>`（非ログインシェル。プロファイルは読み込みません）
- **cwd** は worktree（または実効 cwd）で、Grok が任意に変更している可能性があります
- ホスト上でスクラブ済みの環境変数で実行され、Grok の `--sandbox workspace` の**下ではありません**

したがって、worktree 内で生成された `package.json`、テストファイル、スクリプトが、ユーザーのホスト `PATH` と権限で実行されます。**信頼できるプロンプトとリポジトリに対してのみ `test_command` を渡してください。** 実効モードが `read_only` の場合は完全に拒否されます（`GROK_MCP_INVALID_ARGS`）。

## 環境変数

| 変数 | 既定 | 意味 |
|----------|---------|---------|
| `GROK_MCP_GROK_BIN` | `~/.grok/bin/grok` または `PATH` | Grok バイナリ |
| `GROK_MCP_ALLOWED_ROOTS` | `$HOME` | コロン区切りの絶対パスルート |
| `GROK_MCP_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`（stderr へ JSON） |
| `GROK_MCP_MAX_CONCURRENT` | `2` | Grok の並列実行数 |
| `GROK_MCP_SANDBOX` | `workspace` | write モードのサンドボックスプロファイル |
| `GROK_MCP_USE_GROK_WORKTREE` | `0` | Grok の `-w` 経路をオプトイン |
| `GROK_MCP_FAIL_ON_ORIGINAL_DIRTY` | `0` | 元ツリーが変更されたらエラーにする |
| `GROK_MCP_CACHE_DIR` | `~/.cache/codex-grok-mcp` | セッション + worktree + diff artifact |
| `GROK_MCP_WORKTREE_TTL_HOURS` | `72` | worktree **および** diff artifact の GC の TTL（起動時のみ） |
| `GROK_MCP_INLINE_DIFF_MAX_BYTES` | `65536` | `response_mode: "auto"` がこのバイト数以下の diff を inline します。超えると `compact` へフォールバック。`0` = 常に inline しない。**diff のみ**が対象で `tests.output` や `summary` には影響しません |
| `GROK_MCP_INLINE_DIFF_HARD_MAX_BYTES` | `1048576` | inline の絶対上限。これを超える diff は `response_mode: "full"` でも `compact` へ降格します（警告 `DIFF_HARD_LIMIT_APPLIED`） |
| `GROK_MCP_MAX_DIFF_BYTES` | `0` *(無制限)* | patch 本文そのものに対する任意設定の絶対上限。`0` は切り詰めを完全に無効化し、過大な diff は丸ごと artifact へ送られます。非ゼロにすると patch を切り、`diff_truncated: true` / `diff_complete: false` / `original_diff_bytes` を設定します。最大 512 MiB |
| `GROK_MCP_MAX_TEST_OUTPUT_BYTES` | `65536` | **失敗**した `test_command`（非ゼロ終了）の `tests.output` 上限。末尾を保持。`response_mode` とは独立。最大 16 MiB |
| `GROK_MCP_MAX_TEST_OUTPUT_SUCCESS_BYTES` | `4096` | **成功**した `test_command`（終了コード 0）の `tests.output` 上限。成功時の出力はほぼノイズなので、compact な MCP レスポンスを圧迫しないよう小さく保ちます。最大 16 MiB |

> **本リリースでの変更点。** `GROK_MCP_MAX_DIFF_BYTES` は以前、既定 1 MiB で diff 収集中に切り詰めを行っていました。つまり `response_mode` が動く*前*に切っていたため、`compact` の artifact ですら黙って切られた patch を保持していました。現在は既定で無効化され、設定した場合はレスポンスモード段で適用され、正直に報告されます。`git` の出力はいずれにせよメモリへ全量バッファされるため、旧来の上限はピークメモリの削減にはなっていませんでした。メモリ対策には `GROK_MCP_MAX_UNTRACKED_FILE_BYTES`（読み込み前の上限）を使ってください。

inline のバイト上限は 16 MiB までの非負整数を受け付けます。それ以外（負数、`NaN`、小数、非数値、上限超過）は**無視**され、既定値が使われるとともに起動時に **stderr** へ警告が出力されます。

## 利用側のワークフロー（Codex）

`grok_implement` / `grok_debug` の後:

1. `worktree_path`、`changed_files`、`diff` を読む
2. `diff_included` が `false` なら `diff_artifact_path` か worktree から patch を取得する — [`compact` 結果を確認する手順](#compact-結果を確認する手順)を参照
3. patch をレビューする
4. `git -C <original> apply` で適用するか、worktree からファイルをコピーする
5. `warnings` に `ORIGINAL_TREE_DIRTY` が含まれる場合は自動適用を止めて調査する
6. `grok_continue` + `session_id` で反復する（新しい worktree は作られません）

### `grok_continue`（write モードの再開）

write モードの continue は**厳格**です。次を要求します。

1. `session_id` に対する MCP セッションレコードが**保存済み**であること（未マップの write セッションは拒否）
2. そのレコードのモードが `write_worktree` かつ **`managed: true`**（サーバーが作成した worktree）であること
3. 保存された `worktree_path` が存在し、管理下のキャッシュルート配下にあり、`working_directory` と同じリポジトリに対して `git worktree list` に**登録済み**で、元リポジトリのルートではないこと
4. 呼び出し側が `worktree_path` を渡す場合、保存されたパス（realpath）と**完全一致**すること。不一致は `GROK_MCP_WORKTREE_INVALID`

continue で `-w` を渡すことは決してありません。worktree が無い場合は `GROK_MCP_WORKTREE_MISSING`（`allow_missing_worktree` が指定され、**かつ**明示的な `mode=write_worktree` が無い場合のみ read_only へ降格）。

### worktree の GC

TTL GC は**サーバー起動時のみ**実行され（ツール呼び出し後には走りません）、**検証済みの管理下 worktree だけ**を削除します。

- パスが絶対で、`realpath` 解決済みで、`~/.cache/codex-grok-mcp/worktrees`（または `GROK_MCP_CACHE_DIR`）の**厳密に下**にあること
- 元リポジトリのルートでないこと
- `git worktree list` でそのリポジトリに登録されていること
- セッションエントリは `managed === true` であること（pending worktree は常にサーバー作成）

信頼できない、未登録、ルート外のパスは、たとえ `sessions.json` が悪意あるものでも**決して**削除されません。

diff artifact も同じパスで同じ TTL、同等の検証のもとで GC されます（[diff artifact](#diff-artifact) を参照）。

## 開発

```bash
npm test          # ユニット + 統合（mock grok）
npm run build
npm run typecheck
npm run dev       # stdio サーバー（手動 MCP アタッチ用）
```

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) が、`main` への push とすべてのプルリクエストで `npm ci`、`typecheck`、`test`、`build` を実行します。

| ランナー | Node | 理由 |
|--------|------|-----|
| `ubuntu-latest` | 20 | `engines` の下限 |
| `ubuntu-latest` | 22 | 現行 LTS |
| `macos-latest` | 22 | パス比較は Darwin でのみ case-fold するため（[`src/path-guard.ts`](src/path-guard.ts) の `IS_DARWIN`）、worktree と artifact のガードが別分岐を通ります |

テストは実際の `git` とシェルの mock を spawn します。各フィクスチャのリポジトリが自分で `user.name` / `user.email` を設定するため、CI 側でグローバルな git identity は設定していません。

GitHub 上でのレビューについて: `package-lock.json` は [`.gitattributes`](.gitattributes) で `linguist-generated` としているため、プルリクエストの diff で自動的に畳まれます。また [`.github/pull_request_template.md`](.github/pull_request_template.md) が `AGENTS.md` の契約・セキュリティチェックリストを引き継ぎます。

設計: [`docs/design-codex-grok-mcp.md`](docs/design-codex-grok-mcp.md)  
エージェント向けメモ: [`AGENTS.md`](AGENTS.md)

## エラー形式

ハンドラから返るツール失敗は、固定された JSON エンベロープを使います。

```json
{
  "error_version": 1,
  "code": "GROK_MCP_INVALID_ARGS",
  "message": "…",
  "details": {}
}
```

ハンドラ内の明示的な Zod `.parse` によるスキーマ失敗も含みます（`GROK_MCP_INVALID_ARGS` へ変換）。パス / モード / 実行時エラーも同じ形式です。

**残る例外:** MCP SDK は、ハンドラが動く*前*に登録済み `inputSchema` を検証することがあります。SDK が先に拒否した場合、ホストにはエンベロープではなく生の JSON-RPC `-32602 Input validation error: …` が見えることがあります。この経路はこのサーバーの制御外です。

## トラブルシューティング

| 症状 | 対処 |
|---------|-----|
| ツールが約60秒でキャンセルされる | Codex の MCP 設定で `tool_timeout_sec = 2400`、**または** Claude Code なら `MCP_TOOL_TIMEOUT=2400000` を設定 |
| `npm run build` 後も変更が反映されない | ホストを再起動 / MCP サーバーを再接続（プロセスはホットリロードされません） |
| `GROK_MCP_GROK_NOT_FOUND` | Grok CLI をインストールし `GROK_MCP_GROK_BIN` を設定 |
| `GROK_MCP_NOT_A_GIT_REPO` | git を init するか、`grok_analyze`（読み取り専用）を使う |
| `GROK_MCP_PATH_NOT_ALLOWED` | `GROK_MCP_ALLOWED_ROOTS` を広げる |
| 孤立した worktree | `git worktree list` を確認し、`~/.cache/codex-grok-mcp/worktrees` 配下の管理下パスのみ削除（GC は非管理パスを元々拒否します） |
| 再開に失敗する | 前回結果の `session_id` を正確に渡す。write の continue には保存済み・**managed**・同一リポジトリに登録済みの worktree が必要 |
| `test_command` が拒否される | 実効 `write_worktree` でのみ有効。analyze / review / read_only では省略する |
| `permission_mode` / `sandbox` が拒否される | read_only は危険な上書きを禁止（`bypassPermissions`、`off`、`workspace` など） |
| `diff` が空で返る | `diff_included` / `response_mode_effective` を確認。`diff_artifact_path` を読むか、`response_mode: "full"` で再実行 |
| `DIFF_ARTIFACT_WRITE_FAILED` | キャッシュルートが書き込み不可。`GROK_MCP_CACHE_DIR` の権限と空き容量を確認。結果は `summary_only` へ縮退しています |
| diff artifact が溜まる | サーバー起動時に `GROK_MCP_WORKTREE_TTL_HOURS` で失効します。すぐ回収したい場合は `~/.cache/codex-grok-mcp/diffs` を削除 |
| 生の `-32602` 検証エラー | ハンドラ到達前に SDK が引数を拒否しています。メッセージ中のフィールドを修正してください（エンベロープはハンドラ実行後にのみ適用されます） |

## ライセンス

MIT
