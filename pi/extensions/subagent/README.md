# subagent extension

A Pi extension that delegates tasks to specialized subagents running in their own Pi processes inside tmux panes. Communicates over a typed Unix domain socket bus; never via `tmux capture-pane` or `tmux send-keys`.

See [PLAN.md](../../../PLAN.md) for the full design.

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

| Agent       | Use case                                                            | Tools                                   | Worktree | Placement       |
| ----------- | ------------------------------------------------------------------- | --------------------------------------- | -------- | --------------- |
| `scout`     | Read-only recon                                                     | read, grep, find, ls, bash              | false    | split-right     |
| `linter`    | Run linter, report findings                                         | read, grep, find, ls, bash              | false    | split-right     |
| `tester`    | Run tests, report failures                                          | read, grep, find, ls, bash              | false    | split-right     |
| `reviewer`  | Review code, report concerns                                        | read, grep, find, ls, bash              | false    | split-right     |
| `formatter` | Run formatter, write changes, report                                | read, write, edit, grep, find, ls, bash | false    | split-right     |
| `worker`    | Implement scoped change in isolated worktree, commit, report branch | read, write, edit, grep, find, ls, bash | true     | window-detached |

You can override any of these by adding a `.md` file with the same name under `<repo>/.pi/agents/` (project) or `~/.pi/agent/agents/` (user; the symlinks above target the shipped versions).

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

## Known limitations (v1)

- The `ask_policy` of `"llm"` (let the main LLM answer the subagent's clarifying questions) is not implemented; only `"human"` and `"deny"`.
- Reconnection on a dropped UDS is not supported; a closed socket terminates the task.
- Hard bash denylists for soft-control agents (e.g. blocking `git commit` for the `formatter`) are not enforced; the agent's system prompt is the only constraint.
- Headless `pi -p` does not wait for background subagents.
