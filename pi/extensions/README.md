# Pi extensions

A small collection of [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) extensions that are general enough to be portable across machines and users. Each extension is a self-contained TypeScript module with no dependencies outside of `@earendil-works/pi-coding-agent` and the Node standard library.

## Installation

Pi auto-discovers extensions placed in either:

- `~/.pi/agent/extensions/` (global, all sessions)
- `.pi/extensions/` (project-local, current repo only)

Symlink or copy the files you want from this directory into one of those locations, then run `/reload` in a running pi session (or just start a new one).

For example, to enable all of them globally:

```bash
for f in pi/extensions/*.ts; do
  ln -s "$PWD/$f" ~/.pi/agent/extensions/
done
```

See the [pi extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) for the full lifecycle, event, and API reference.

## Extensions

### `edit-answer.ts`

Adds a `/edit-answer` slash command that opens the most recent assistant answer in `$EDITOR`. The edited buffer is dropped back into the input editor on save, which is useful for "the answer was 90% right, let me hand-tweak it and send it as the next prompt".

Append `pick` (or `--pick`) to choose from the 20 most recent answers via a selector instead of always taking the latest.

**Requires:** `$EDITOR` set to a terminal editor that takes over stdio (`vim`, `nvim`, `emacs -nw`, etc.). Falls back to `vim`. GUI editors that return immediately will not work.

### `jj-guard.ts`

Hooks the `tool_call` event and blocks raw `git add`, `git stage`, and `git commit` invocations whenever pi is running inside a Jujutsu repository (detected by walking up to a `.git` worktree root and checking for a sibling `.jj` directory).

Intended as a guardrail against LLMs that reflexively reach for git commands even when the project uses `jj` (not a security boundary; the regexes are heuristic and won't catch every obfuscated invocation).

**Requires:** `git` and (for the check to fire) a `.jj` directory in the repo root.

### `model-info.ts`

Hooks `before_agent_start` and appends a "Pi runtime" block to the system prompt on every turn:

```
## Pi runtime

- Active model: `anthropic/claude-opus-4-7` (Claude Opus 4.7)
- Active thinking level: `xhigh`
```

This gives the agent a reliable way to identify itself at runtime, which matters for skills that need accurate self-attribution. For example, the `git-commit` and `jj-commit` skills in this repo derive their `Co-Authored-By` trailer from the model identity; without this extension they fall back to a generic `AI Assistant <noreply@example.com>` line.

Because the block is regenerated every turn, `/model` and `/thinking` changes are reflected live without restarting pi.

### `total-cost.ts`

Adds a `/total-cost` slash command that scans every saved pi session under `$PI_CODING_AGENT_DIR/sessions` (default `~/.pi/agent/sessions`) and shows a per-month breakdown of cumulative LLM cost, message count, and number of distinct sessions:

```
Month       Cost   Messages   Sessions
─────────────────────────────────────
2026-05   $42.17        318         24
2026-04   $89.04        612         41
─────────────────────────────────────
Total    $131.21        930         65
```

Costs are pulled from the `usage.cost.total` field stored on each assistant message; months are bucketed by entry-level ISO timestamp (UTC). Sessions without cost data (e.g. local/free models) are silently skipped.

Renders as a TUI modal when running interactively, or plain text on stdout in non-interactive mode.
