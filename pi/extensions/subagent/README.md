# subagent extension

A Pi extension that delegates tasks to specialized subagents running in their own Pi processes inside tmux panes. Communicates over a typed Unix domain socket bus; never via `tmux capture-pane` or `tmux send-keys`.

## Install

The six default agents under `agents/` are auto-discovered relative to the loaded extension module. To override a shipped agent or add a project-local one, drop a `.md` file with the same name (or a new name) under `<repo>/.pi/agents/` (project-scoped) or `~/.pi/agent/agents/` (user-scoped); both shadow the extension-bundled tier.

The companion skill at [`pi/skills/subagent/`](../../skills/subagent/) and the prompts under `prompts/` are discovered by Pi itself, not by this extension.

## Requirements

- Pi (globally installed; see [parent README](../README.md))
- tmux 3.2 or later, running. The extension verifies `$TMUX` at spawn time and fails loudly if absent.
- git (only for the `worker` agent; `worktree: true` requires the repo to have at least one commit).

## What you get

When loaded in main mode (no `PI_SUBAGENT_TASK_ID` in the environment), the extension registers four tools:

| Tool              | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `subagent`        | Spawn a subagent and (by default) wait synchronously for its report. |
| `subagent_steer`  | Send a steering message to a running subagent.                       |
| `subagent_cancel` | Cancel a running subagent (graceful, then SIGTERM, then SIGKILL).    |
| `subagent_status` | List active subagents or show status for one task_id.                |

When loaded in sub mode (env vars set by the spawner), the extension registers three tools:

| Tool       | Purpose                                                      |
| ---------- | ------------------------------------------------------------ |
| `report`   | Send a structured report to the main agent.                  |
| `progress` | Send a short status update to the main agent.                |
| `ask`      | Ask the main agent (or watching user) a clarifying question. |

It also emits lifecycle events on `pi.events`: `subagent:spawned`, `subagent:connected`, `subagent:progress`, `subagent:report`, `subagent:asked`, `subagent:answered`, `subagent:steered`, `subagent:done`, `subagent:failed`. The namespace is singular to coexist with `@tintinweb/pi-subagents`' plural `subagents:*` namespace.

## Default agents

The extension ships six agent personalities under `agents/`. They are discovered from `~/.pi/agent/agents/` (user) and `<repo>/.pi/agents/` (project) once symlinked.

| Agent       | Use case                                                            | Tools                                   | Worktree | Placement       | ask_policy |
| ----------- | ------------------------------------------------------------------- | --------------------------------------- | -------- | --------------- | ---------- |
| `scout`     | Read-only recon                                                     | read, grep, find, ls, bash              | false    | split-right     | (human)    |
| `linter`    | Run linter, report findings                                         | read, grep, find, ls, bash              | false    | split-right     | (human)    |
| `tester`    | Run tests, report failures                                          | read, grep, find, ls, bash              | false    | split-right     | (human)    |
| `reviewer`  | Review code, report concerns                                        | read, grep, find, ls, bash              | false    | split-right     | (human)    |
| `formatter` | Run formatter, write changes, report                                | read, write, edit, grep, find, ls, bash | false    | split-right     | (human)    |
| `worker`    | Implement scoped change in isolated worktree, commit, report branch | read, write, edit, grep, find, ls, bash | true     | window-detached | deny       |

Parenthesised values mean the agent file does not set the field explicitly and the global default applies. You can override any of these by adding a `.md` file with the same name under `<repo>/.pi/agents/` (project) or `~/.pi/agent/agents/` (user; the symlinks above target the shipped versions).

## Agent frontmatter

Agent `.md` files start with YAML-ish frontmatter:

| Field              | Required | Values                                                             | Notes                                                                                                                              |
| ------------------ | -------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `description`      | yes      | string                                                             | One-line summary surfaced to the main agent.                                                                                       |
| `tools`            | yes      | comma-separated list                                               | Allowed tools (in addition to the runtime bus tools `report`, `progress`, `ask`).                                                  |
| `disallowed_tools` | no       | comma-separated list                                               | Explicit denylist.                                                                                                                 |
| `placement`        | no       | `split-right` (default), `split-down`, `window`, `window-detached` | tmux placement for the spawned pane.                                                                                               |
| `worktree`         | no       | `true` / `false` (default `false`)                                 | Provision an isolated git worktree (case-2 isolation).                                                                             |
| `close_on_success` | no       | `true` (default) / `false`                                         | Whether to close the pane when the subagent finishes cleanly.                                                                      |
| `ask_policy`       | no       | `human` (default), `deny`, `llm`                                   | How to answer the subagent's `ask` envelopes. Per-call argument to the `subagent` tool overrides this. See the skill for guidance. |

Fields the agent file does not set fall through to per-call defaults and ultimately to the extension defaults shown above.

## Where state lives

Per-task state lives at `${XDG_STATE_HOME:-~/.local/state}/pi/subagent/<task_id>/`:

- `meta.json`: task metadata (status, pids, pane id, started/ended timestamps)
- `main.sock`: Unix domain socket the main side listens on (cleaned up on close)
- `bus.jsonl`: append-only audit log of every envelope in both directions
- `system-prompt.md`: the rendered system prompt the subagent was given
- `task.txt` / `run.sh`: wrapper artifacts written by the spawner
- `worktree`: symlink to the isolated worktree, when `worktree: true`

On extension load, stale entries whose recorded pids are gone are marked `crashed` automatically.

## Worktree handling

For `worktree: true` agents (case 2), the extension:

1. Creates a sibling directory `<repo>-subagent-worktrees/<task_id>/`.
2. Runs `git worktree add --detach` against HEAD.
3. Sets the subagent's cwd to that worktree.
4. After the subagent exits:
   - If changes exist: stages, commits with `subagent(<agent>): <truncated task>`, creates branch `subagent/<agent>/<short_task_id>`, prunes the worktree.
   - If clean: prunes the worktree.
   - If something went wrong: leaves the worktree intact, reports its path.

The branch is the artefact; the worktree directory is internal. The main agent decides whether to merge, PR, or abandon.

## Files

```
pi/extensions/subagent/
  index.ts                  # role dispatch
  bus/
    envelope.ts             # envelope schema + validators
    transport-uds.ts        # UDS listen/connect with framing
    audit-log.ts            # serialized JSONL writer
    bus.ts                  # high-level Bus API (multi-subscriber, request/reply)
  main/
    agents.ts               # discovery of agent .md files
    events.ts               # pi.events lifecycle emitters
    registry.ts             # in-process map of active tasks
    routing.ts              # extension-scoped routing for background tasks
    spawn.ts                # tmux pane spawning, env handoff, titles
    state.ts                # state-dir layout and stale-entry reaper
    tools.ts                # subagent, subagent_steer, subagent_cancel, subagent_status
    worktree.ts             # git worktree lifecycle (case 2)
  sub/
    routing.ts              # steer/cancel/answer handlers
    tools.ts                # report, ask, progress
  agents/                   # bundled agent .md files
  prompts/                  # bundled workflow prompts (e.g. /sweep)
  tests/                    # unit + integration harnesses
```

## `ask_policy: llm` budget

When a task runs with `ask_policy: llm`, each successful LLM-answered question costs one `complete()` round-trip against `ctx.model`. To bound that spend and to keep a human in the loop, the extension counts those answers and escalates to a `human` prompt every `LLM_ASK_BUDGET` answers (10, defined at the top of `main/ask.ts`). The escalation prompt shows the question and the budget context; whatever the user types becomes the answer (`source: "human-escalated"`), and the counter resets so the subagent gets another 10 LLM answers before the next check-in. If the user dismisses the prompt or no UI is available, the subagent unblocks with the deny-style reply (`source: "policy-escalated"`) and the counter still resets.

The lifetime total of LLM-answered questions is surfaced as `llmAnswersTotal` on the `subagent:answered` and `subagent:done` lifecycle events for diagnostics.

## Known limitations (v1)

- Reconnection on a dropped UDS is not supported; a closed socket terminates the task.
- Hard bash denylists for soft-control agents (e.g. blocking `git commit` for the `formatter`) are not enforced; the agent's system prompt is the only constraint.
- Headless `pi -p` does not wait for background subagents.
