# Pi extensions

A small collection of [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) extensions that are general enough to be portable across machines and users. Each extension is a self-contained TypeScript module with no dependencies outside of `@earendil-works/pi-coding-agent` and the Node standard library.

## Installation

Follow the [top-level Pi setup](../../README.md#pi-setup) to clone this repository into `~/.local/share/agents/wincent-agent-plugins` and configure Pi to load its extensions, skills, and prompt templates. Run `/reload` in a running Pi session or start a new one after changing resource settings.

To load only selected extensions, list their files or entry-point directories in Pi's `extensions` setting instead of the entire directory. Keep them in the checkout so relative imports and bundled resources remain available.

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

Requires per-call confirmation for writes through Pi's native MCP server named `datadog`, including calls made inside codemode. Unknown or unannotated tools require confirmation too; without a UI they are blocked. Enable built-in MCP and configure the server in `mcp.json` with an `Authorization` header containing the credential proxy's phantom token, not a real credential. Use `/mcp` for connection status and reconnection. The companion `datadog-mcp` skill explains discovery and calls.

Run `bin/datadog-mcp-auth login`, `status`, or `logout` on the host to manage authentication. The credential proxy invokes `token` with capture caching disabled; `token --refresh >/dev/null` explicitly refreshes a rejected token without displaying it. Use only this helper to manage the grant, not Pi's native OAuth commands.

The helper defaults to `mcp.datadoghq.com`; `DATADOG_MCP_DOMAIN` selects another site and must match the proxy route and MCP URL. Registrations and tokens are stored as private plaintext JSON under `$XDG_STATE_HOME/pi/datadog-mcp/` (default `~/.local/state/pi/datadog-mcp/`). Never copy this state into a sandbox or VM.

### `google-workspace-mcp.ts`

Requires per-call confirmation for writes through Pi's native MCP server named `google_workspace`, including calls inside codemode. Only the local allowlist of known reads bypasses confirmation; explicit destructive or non-read-only annotations override that allowlist. Unknown tools require confirmation even when the server labels them read-only. Without a confirmation UI, these calls are blocked.

Enable built-in MCP and configure the service's literal HTTPS `/mcp` URL in `mcp.json` with `Authorization: Bearer ${GOOGLE_WORKSPACE_MCP_TOKEN}`, using the credential proxy's phantom token rather than a real credential. Use `/mcp` for connection status and reconnection. The companion `google-workspace-mcp` skill explains native discovery and calls.

On the host, set `GOOGLE_WORKSPACE_MCP_URL` to the matching resource URL and use `bin/google-workspace-mcp-auth login`, `status`, or `logout`. Select the work account authorized for the configured service. The callback defaults to port `19877`, overridable with `GOOGLE_WORKSPACE_MCP_CALLBACK_PORT`. The credential proxy invokes `token` with capture caching disabled; `token --refresh >/dev/null` explicitly refreshes a rejected token. Use only this helper to manage the grant, not Pi's native OAuth commands.

Credentials are stored as private plaintext JSON under `$XDG_STATE_HOME/pi/google-workspace-mcp-host/` (default `~/.local/state/pi/google-workspace-mcp-host/`). Logout removes the local client and tokens, not server or Google authorization. Keep credentials and the helper on the host.

### `slack-mcp.ts`

Requires per-call confirmation for writes through Pi's native MCP server named `slack`, including calls inside codemode. Unknown or unannotated tools require confirmation too; without a UI they are blocked. Configure `https://mcp.slack.com/mcp` in `mcp.json` with an `Authorization` header containing the credential proxy's phantom token, not a real credential. Use `/mcp` for connection status and reconnection. The companion `slack-mcp` skill explains discovery and calls.

Run `bin/slack-mcp-auth login`, `status`, or `logout` on the host to manage authentication. Select the intended workspace on the consent screen. The credential proxy invokes `token` with capture caching disabled; `token --refresh >/dev/null` explicitly refreshes a rejected token without displaying it. Use only this helper to manage the grant, not Pi's native OAuth commands.

Credentials are stored as private plaintext JSON under `$XDG_STATE_HOME/pi/slack-mcp/` (default `~/.local/state/pi/slack-mcp/`). Never copy this state into a sandbox or VM. Slack attributes activity to Claude Code, but no Claude installation is needed.

### `context-breakdown.ts`

Adds a `/context` slash command that shows how the current context window is being used. This is a counterpart to the built-in `/session`, which reports _cumulative_ session billing rather than current context composition, and to the footer, which reports context usage as a single opaque percentage.

The total uses provider usage once a usable assistant response exists after the latest compaction or context edit; until then, it is estimated. Categories are always estimates, with discrepancies shown as "Unaccounted".

### `total-cost.ts`

Adds `/total-cost`, showing monthly LLM cost, message count, and session count, broken down by model. Reads saved sessions under `$PI_CODING_AGENT_DIR/sessions` and `subagent-sessions` (default base: `~/.pi/agent`). Deleted transcripts and ephemeral runs do not contribute; see [subagent state and inspection](subagent/README.md#state-and-inspection) for retention and older transcript handling.

It accepts two optional arguments:

- `no-model-breakdown` suppresses the per-model columns and shows totals only, for a compact view on narrow terminals.
- any other word is treated as a model-name filter: only models whose name contains one of the given substrings are counted, and the cost, message, and session columns reflect just those models. For example `/total-cost claude` restricts the table to Claude models, and `/total-cost gpt gemini` keeps both families. Filters and `no-model-breakdown` can be combined (e.g. `/total-cost claude no-model-breakdown`).

Costs include assistant messages, standalone usage entries (such as cache warming), and tool-result usage (including classifiers and nested tool calls). Tool results can pool multiple models, so their costs appear in a separate `tools` column rather than being attributed to a model. `/total-cost tools` selects that bucket; model-name filters exclude it unless `tools` is also requested. Only assistant messages increment the message count, and nested usage is counted once from the parent tool result.

Renders as a TUI modal when running interactively, or plain text on stdout in non-interactive mode.
