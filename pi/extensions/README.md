# Pi extensions

A small collection of [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) extensions that are general enough to be portable across machines and users. Each extension is a self-contained TypeScript module with no dependencies outside of `@earendil-works/pi-coding-agent` and the Node standard library.

## Installation

Pi auto-discovers extensions placed in either:

- `~/.pi/agent/extensions/` (global, all sessions)
- `.pi/extensions/` (project-local, current repo only)

Symlink or copy the files you want from this directory into one of those locations, then run `/reload` in a running Pi session (or just start a new one). Alternatively, if you've installed the plugin marketplace in Claude, you can configure Pi to look for extensions under `~/.claude/plugins/marketplaces/wincent-agent-plugins/` (see the [top-level README](../../README.md) for details).

See the [pi extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) for the full lifecycle, event, and API reference.

## Type-checking

Run `bin/typecheck` from the repository root. Missing type stubs are copied automatically from the managed Pi installation at `~/n/pi`.

After each Pi upgrade, run `bin/install-types` manually; otherwise checks may still use the previous version's API. Do not run `npm install` here: extensions use Pi's runtime dependencies, and this directory needs only their types.

## Extensions

### `edit-answer.ts`

Adds a `/edit-answer` slash command that opens the most recent assistant answer in `$EDITOR`. The edited buffer is dropped back into the input editor on save, which is useful for "the answer was 90% right, let me hand-tweak it and send it as the next prompt".

Append `pick` (or `--pick`) to choose from the 20 most recent answers via a selector instead of always taking the latest.

**Requires:** `$EDITOR` set to a terminal editor that takes over stdio (`vim`, `nvim`, `emacs -nw`, etc.). Falls back to `vim`. GUI editors that return immediately will not work.

### `jj-guard.ts`

Blocks raw `git add`, `git stage`, and `git commit` invocations inside Jujutsu repositories.

Intended as a guardrail against LLMs that reflexively reach for git commands even when the project uses `jj` (not a security boundary; the regexes are heuristic and won't catch every obfuscated invocation).

**Requires:** `git` and (for the check to fire) a `.jj` directory in the repo root.

### `model-info.ts`

Adds the active model and thinking level to the system prompt, reflecting `/model` and `/thinking` changes without restarting Pi. The commit skills use this identity for their `Co-Authored-By` trailers.

### `ocr/`

Adds an `ocr` tool for local PDFs and PNG/JPEG images through the nono credential proxy, plus `/ocr-status` and `/ocr-approval`. Uploads require session-wide approval and incur API charges. See the [OCR README](ocr/README.md) for setup, limits, approval inheritance, and privacy; the companion `ocr` skill covers document handling.

### `sandbox.ts`

Shows `Sandbox ✔` in the TUI footer when `NONO_CAP_FILE` is non-empty. This is a launcher hint, not verification of sandbox enforcement.

### `subagent/`

Delegates focused tasks to headless Pi agents, with progress in the controlling UI and retained reports/logs. Includes `scout`, `linter`, `tester`, `reviewer`, `formatter`, and commit-producing `worker` agents. See the [subagent README](subagent/README.md) for tools, configuration, and lifecycle constraints.

### `datadog-mcp.ts`

Talks to Datadog's MCP server.

Registers three slash commands:

- `/datadog-login` signs in via the browser.
- `/datadog-logout` clears stored tokens for the current domain.
- `/datadog-status` shows connection status (no token material).

A companion `datadog-mcp` skill under `pi/skills/datadog-mcp/` teaches the agent the `list_tools`, `describe_tool`, and `call_tool` pattern. Mutating tools always require a confirmation prompt. The target site defaults to `mcp.datadoghq.com`, overridable via `DATADOG_MCP_DOMAIN`.

The dynamic client registration metadata and OAuth tokens are stored as plaintext JSON under `$XDG_STATE_HOME/pi/datadog-mcp/` (default `~/.local/state/pi/datadog-mcp/`). An unset, empty, or relative `XDG_STATE_HOME` uses the default. This state is independent of `PI_CODING_AGENT_DIR`, keeping credentials outside configuration directories that may be version-controlled. Directories and files are restricted to modes `0700` and `0600` on POSIX systems. This is not an OS credential store.

### `google-workspace-mcp.ts`

Talks to a configured Google Workspace MCP server that provides access to Google Drive, Sheets, Docs, and Slides.

Registers three slash commands:

- `/google-workspace-login` signs in through the browser using OAuth with PKCE and dynamic client registration.
- `/google-workspace-logout` clears locally stored tokens; pass `all` to also clear the dynamic client registration.
- `/google-workspace-status` shows connection status without exposing token material.

A companion `google-workspace-mcp` skill under `pi/skills/google-workspace-mcp/` teaches the agent the `list_tools`, `describe_tool`, and `call_tool` pattern. Mutating tools always require a confirmation prompt; only a local allowlist of known read operations bypasses the gate, so unknown server tools default to mutating. `GOOGLE_WORKSPACE_MCP_URL` is required. `GOOGLE_WORKSPACE_MCP_ACCOUNT_DOMAIN` optionally customizes account guidance, and the local OAuth callback port defaults to `19877` with an override available through `GOOGLE_WORKSPACE_MCP_CALLBACK_PORT`.

The dynamic client registration metadata and OAuth tokens are stored as plaintext JSON under `$XDG_STATE_HOME/pi/google-workspace-mcp/` (default `~/.local/state/pi/google-workspace-mcp/`). An unset, empty, or relative `XDG_STATE_HOME` uses the default. This state is independent of `PI_CODING_AGENT_DIR`, keeping credentials outside configuration directories that may be version-controlled. Directories and files are restricted to modes `0700` and `0600` on POSIX systems. This is not an OS credential store.

### `slack-mcp.ts`

Uses an OAuth grant previously obtained from Claude to talk to Slack's MCP server.

Registers two slash commands:

- `/slack-status` shows status of Slack connection.
- `/slack-refresh` forces a token refresh.

A companion `slack-mcp` skill under `pi/skills/slack-mcp/` teaches the agent how to use the `list_tools`, `describe_tool`, and `call_tool` commands. Mutating tools always require a confirmation prompt.

### `context-breakdown.ts`

Adds a `/context` slash command, similar to the one from Claude Code, that shows how the current context window is being used. This is a counterpart to the built-in `/session`, which reports _cumulative_ session billing rather than current context composition, and to the footer, which reports context usage as a single opaque percentage.

The total uses provider usage once a usable assistant response exists after the latest compaction or context edit; until then, it is estimated. Categories are always estimates, with discrepancies shown as "Unaccounted".

### `total-cost.ts`

Adds `/total-cost`, showing monthly LLM cost, message count, and session count, broken down by model. Reads saved sessions under `$PI_CODING_AGENT_DIR/sessions` and `subagent-sessions` (default base: `~/.pi/agent`). Deleted transcripts and ephemeral runs do not contribute; see [subagent state and inspection](subagent/README.md#state-and-inspection) for retention and older transcript handling.

It accepts two optional arguments:

- `no-model-breakdown` suppresses the per-model columns and shows totals only, for a compact view on narrow terminals.
- any other word is treated as a model-name filter: only models whose name contains one of the given substrings are counted, and the cost, message, and session columns reflect just those models. For example `/total-cost claude` restricts the table to Claude models, and `/total-cost gpt gemini` keeps both families. Filters and `no-model-breakdown` can be combined (e.g. `/total-cost claude no-model-breakdown`).

Costs include assistant messages, standalone usage entries (such as cache warming), and tool-result usage (including classifiers and nested tool calls). Tool results can pool multiple models, so their costs appear in a separate `tools` column rather than being attributed to a model. `/total-cost tools` selects that bucket; model-name filters exclude it unless `tools` is also requested. Only assistant messages increment the message count, and nested usage is counted once from the parent tool result.

Renders as a TUI modal when running interactively, or plain text on stdout in non-interactive mode.
