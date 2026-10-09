# subagent extension

A Pi extension that delegates tasks to specialized subagents running as direct, headless Pi child processes. Communication uses a typed Unix domain socket bus. No tmux server, pane, or socket is required.

## Install

The six default agents under `agents/` are auto-discovered relative to the loaded extension module. To override a shipped agent or add a project-local one, drop a `.md` file with the same name (or a new name) under `<repo>/.pi/agents/` (project-scoped) or `~/.pi/agent/agents/` (user-scoped); both shadow the extension-bundled tier.

The companion skill at [`pi/skills/subagent/`](../../skills/subagent/) and the prompts under `prompts/` are discovered by Pi itself, not by this extension.

## Requirements

- Pi (globally installed; see [parent README](../README.md))
- A POSIX environment with `bash`, Unix domain sockets, and process-group signals.
- git (only for the `worker` agent; `worktree: true` requires the repo to have at least one commit).

## What you get

When loaded in main mode (no `PI_SUBAGENT_TASK_ID` in the environment), the extension registers four tools:

| Tool              | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `subagent`        | Spawn a subagent and (by default) wait synchronously for its report. |
| `subagent_steer`  | Send a steering message to a running subagent.                       |
| `subagent_cancel` | Cancel a running subagent (graceful, then SIGTERM, then SIGKILL).    |
| `subagent_status` | List active/recent completed tasks or retrieve a task's full report. |

When loaded in sub mode (env vars set by the spawner), the extension registers three tools:

| Tool       | Purpose                                                      |
| ---------- | ------------------------------------------------------------ |
| `report`   | Send a structured report to the main agent.                  |
| `progress` | Send a short status update to the main agent.                |
| `ask`      | Ask the main agent (or watching user) a clarifying question. |

It also emits lifecycle events on `pi.events`: `subagent:spawned`, `subagent:connected`, `subagent:progress`, `subagent:report`, `subagent:asked`, `subagent:answered`, `subagent:steered`, `subagent:done`, `subagent:failed`. The namespace is singular to coexist with `@tintinweb/pi-subagents`' plural `subagents:*` namespace.

## Model selection

Each subagent inherits the main agent's active provider, model, and thinking level at dispatch time, passed explicitly via `--provider`, `--model`, and `--thinking`. Changing the main agent's settings affects subsequent spawns, not already-running subagents. If the main context has no model, the child uses Pi's normal model selection. Pi may clamp thinking to the selected model's supported levels; exact child-side verification is part of the planned state handoff.

Generic extension state and approval delegation are not implemented yet. In particular, OCR approvals remain local to the controlling session; headless children cannot inherit them yet.

## Launcher

Subagents exec `pi -p` by default, with stdin closed and stdout/stderr redirected to private task logs. If `PI_SUBAGENT_LAUNCHER` is set in the main agent's environment, its value is used instead; it may be a path or a trusted command with arguments. A configured launcher failure never falls back to bare `pi`.

Sandbox/proxy wrappers should set this to their own launcher so each child acquires its own lease. They must permit the task-specific bus connection and task files. Removing tmux eliminates the need for a tmux socket grant, but does not itself validate a nono profile or change its filesystem/network permissions. Required v0 configurations are unsandboxed parent/child and sandboxed parent/child; real nono validation is still pending.

Children exit after their task settles. Cancellation sends a bus message, then escalates to SIGTERM/SIGKILL for the child process group if needed. Completion waits for process exit before finalizing worktrees. Controlling-session shutdown cancels remaining children.

## Default agents

The extension ships six agent personalities under `agents/`. They are discovered from `~/.pi/agent/agents/` (user) and `<repo>/.pi/agents/` (project) once symlinked.

| Agent       | Use case                                       | Tools                                   | Worktree | ask_policy |
| ----------- | ---------------------------------------------- | --------------------------------------- | -------- | ---------- |
| `scout`     | Read-only recon                                | read, grep, find, ls, bash              | false    | (human)    |
| `linter`    | Run linter, report findings                    | read, grep, find, ls, bash              | false    | (human)    |
| `tester`    | Run tests, report failures                     | read, grep, find, ls, bash              | false    | (human)    |
| `reviewer`  | Review code, report concerns                   | read, grep, find, ls, bash              | false    | (human)    |
| `formatter` | Run formatter, write changes, report           | read, write, edit, grep, find, ls, bash | false    | (human)    |
| `worker`    | Implement scoped change, commit, report branch | read, write, edit, grep, find, ls, bash | true     | deny       |

Parenthesised values mean the agent file does not set the field explicitly and the global default applies. You can override any of these by adding a `.md` file with the same name under `<repo>/.pi/agents/` (project) or `~/.pi/agent/agents/` (user; the symlinks above target the shipped versions).

## Agent frontmatter

Agent `.md` files start with YAML-ish frontmatter:

| Field              | Required | Values                             | Notes                                                                                                                              |
| ------------------ | -------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `description`      | yes      | string                             | One-line summary surfaced to the main agent.                                                                                       |
| `tools`            | yes      | comma-separated list               | Allowed tools (in addition to the runtime bus tools `report`, `progress`, `ask`).                                                  |
| `disallowed_tools` | no       | comma-separated list               | Explicit denylist.                                                                                                                 |
| `worktree`         | no       | `true` / `false` (default `false`) | Provision an isolated git worktree (case-2 isolation).                                                                             |
| `ask_policy`       | no       | `human` (default), `deny`, `llm`   | How to answer the subagent's `ask` envelopes. Per-call argument to the `subagent` tool overrides this. See the skill for guidance. |

Per-call `worktree` and `ask_policy` arguments override agent frontmatter. Retired `placement` and `close_on_success` fields in existing agent files are ignored; neither is a tool parameter anymore. All children exit on completion, while logs are retained regardless of success. `disallowed_tools` is passed through Pi's `--exclude-tools`; excluding mandatory bus tools is rejected.

## Where state lives

Per-task state lives at `${XDG_STATE_HOME:-~/.local/state}/pi/subagent/<task_id>/`:

- `meta.json`: task metadata (status, pids, inherited model/thinking, exit code/signal, started/ended timestamps)
- `result.json`: full final result, written atomically with mode `0600` after finalization; retained across sessions
- `main.sock`: Unix domain socket the main side listens on (cleaned up on close)
- `bus.jsonl`: append-only audit log of every envelope in both directions
- `system-prompt.md`: the rendered system prompt the subagent was given
- `task.txt` / `run.sh`: wrapper artifacts written by the spawner
- `stdout.log` / `stderr.log`: child output and diagnostics (mode `0600`)
- `worktree`: symlink to the isolated worktree, when `worktree: true`

On session start, stale entries whose recorded pids are gone are marked `crashed` automatically.

## Results and completed-task history

Synchronous final tool results and background completion messages include model-visible status, full task ID, artifact paths, worktree outcome, and the full `finalReport`: summary, findings, branch/commits, and arbitrary `data`. The UI's `details` object is not the model-facing interface. Task-specific deliverables can live under `finalReport.data`, not just `summary`.

Large results produce an explicitly marked preview (32,000 characters of result data plus identity/path information) and a path to the full saved result. If persistence fails, the result still includes the report and a diagnostic; the audit log remains the fallback inspection surface.

`subagent_status` without arguments lists this controller's active tasks and ten recent completed tasks from the local state directory, including previous sessions. `limit` selects 0 to 50 completed tasks; 0 means active only. Listings provide IDs, brief summaries, and paths. `subagent_status({task_id: "..."})` retrieves the full result for an active or completed task. Older tasks without a saved result can recover their report from the audit log; missing/corrupt artifacts produce an explicit diagnostic rather than hiding the task. Pruning task directories removes their history as well.

## Watching progress

The controlling UI shows a running-task count and a compact progress widget. Synchronous calls also stream progress/report updates in the tool result; background reports and completion arrive as user messages. `subagent_status` exposes each active task's pid and log paths.

For inspection outside Pi, use `tail -F` on the task's `bus.jsonl`, `stdout.log`, or `stderr.log`. Logs remain after the child exits, including on failure. There is no interactive child TUI or attach viewer in this increment.

## Worktree handling

For `worktree: true` agents (case 2), the extension:

1. Creates a sibling directory `<repo>-subagent-worktrees/<task_id>/`.
2. Records the starting commit and runs `git worktree add --detach` against that exact commit.
3. Sets the subagent's cwd to that worktree.
4. After the subagent exits:
   - Detects commits since the recorded starting commit, even if the worker committed everything and left a clean checkout. Later changes to the parent's HEAD do not change that baseline.
   - If uncommitted changes exist: stages and commits with `subagent(<agent>): <truncated task>`.
   - Creates and verifies branch `subagent/<agent>/<task_id>` for committed output before removing the worktree. Existing branches are never overwritten.
   - Only a clean checkout with no new commits is treated as a no-op.
   - If reported commit IDs disagree with Git's detected commits, or retention/cleanup fails: reports failure and preserves the worktree when present. Detected commits and the retained branch remain visible under `worktree`; the child's original `finalReport` is not overwritten.

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
    result.ts               # model-visible results, persistence, completed history
    routing.ts              # extension-scoped routing for background tasks
    spawn.ts                # direct headless spawn, logs, process signals
    launch.ts               # connection/startup race and failed-spawn cleanup
    lifecycle.ts            # cancellation and bus/process outcome reconciliation
    status.ts               # controlling-UI progress widget
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
- A headless controlling `pi -p` does not keep running for background subagents; session shutdown cancels them. Use synchronous calls from a one-shot controller.
- Recursive spawning is not registered in sub mode.

## Tests

Run `node pi/extensions/subagent/tests/run.mjs` from the repository root. The suite covers direct process launch, cancellation escalation, failed-start cleanup, and real headless Pi parent/child execution with an in-memory test provider. The provider makes no network requests and needs no credentials. Real nono sandbox/proxy compatibility remains a separate smoke test.
