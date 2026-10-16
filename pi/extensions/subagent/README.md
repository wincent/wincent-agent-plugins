# subagent extension

Delegate tasks to specialized agents running as headless Pi child processes. The controlling UI shows progress; reports and private logs remain available after completion. No tmux dependency.

## Install

Load the extension as described in the [parent README](../README.md). The six bundled agents are auto-discovered. Add or override agents with `.md` files under `<repo>/.pi/agents/` (project-scoped) or `~/.pi/agent/agents/` (user-scoped); project agents take precedence over user agents, then bundled agents.

The companion [skill](../../skills/subagent/) and workflow prompts under `prompts/` must be discoverable by Pi separately.

Requires an installed Node/Bun Pi CLI, a POSIX environment with `bash`, Unix domain sockets, and process-group signals. SDK hosts and standalone compiled binaries are not supported. Workers require git; isolated worktrees require a repository with at least one commit.

## Tools and execution

| Tool              | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `subagent`        | Spawn a subagent in the background; deliver its report later.        |
| `subagent_steer`  | Redirect a running subagent.                                         |
| `subagent_cancel` | Cancel a task, escalating to SIGTERM/SIGKILL if needed.              |
| `subagent_status` | List active/recent completed tasks or retrieve a task's full report. |

Children receive `report`, `progress`, and `ask` tools instead of delegation tools. Lifecycle events are available on `pi.events` under `subagent:*`; see [events.ts](main/events.ts) for the event contract.

`background` defaults to `true`. Set `background: false` only when the user explicitly requests synchronous execution. Continue independent work or yield the turn; do not busy-poll. Sequential campaigns can launch one background worker at a time. Overlap only independent work and avoid concurrent writes to shared files.

The controller owns child lifetime: session shutdown cancels unfinished tasks. A one-shot `pi -p` controller must stay alive until completion or its caller must explicitly request synchronous delegation. Background dispatch alone does not keep it alive.

Each child inherits the controller's provider, model, thinking level, environment, sandbox, and proxy lifetime at dispatch. Later model changes affect future children only. Children do not rerun launch wrappers, acquire independent proxy leases, or escape the controller's restrictions.

Extensions can opt into [spawn-time state snapshots](../lib/README.md#subagent-state). OCR approval is inherited by subsequently launched children when OCR is loaded and allowed by their tool configuration; later approval or revocation does not reach existing children. This is cooperative workflow state, not authenticated authorization.

## Default agents

| Agent       | Use case                                       | Worktree | ask_policy |
| ----------- | ---------------------------------------------- | -------- | ---------- |
| `scout`     | Read-only reconnaissance                       | false    | human      |
| `linter`    | Run linter, report findings                    | false    | human      |
| `tester`    | Run tests, report failures                     | false    | human      |
| `reviewer`  | Review code, report concerns                   | false    | human      |
| `formatter` | Run formatter, write changes, report           | false    | human      |
| `worker`    | Implement scoped change, commit, report branch | true     | deny       |

See [agents/](agents/) for tool lists and instructions. Prompt restrictions such as "read-only" are not enforced bash denylists. Workers commit even with `worktree: false`; use the main agent or a custom non-committing agent for edits without commits.

## Agent frontmatter

Agent files contain frontmatter followed by a system prompt:

| Field              | Required | Meaning                                                                |
| ------------------ | -------- | ---------------------------------------------------------------------- |
| `description`      | yes      | One-line summary surfaced to the main agent.                           |
| `tools`            | yes      | Comma-separated tool list, plus mandatory `report`, `progress`, `ask`. |
| `disallowed_tools` | no       | Comma-separated denylist; cannot exclude mandatory bus tools.          |
| `worktree`         | no       | Isolated git worktree; defaults to `false`.                            |
| `ask_policy`       | no       | `human` (default), `deny`, or `llm`.                                   |

The `tools` list replaces Pi's default tool selection; top-level defaults do not add tools to it. Per-call `worktree` and `ask_policy` arguments override frontmatter.

`human` prompts the user; `deny` tells the child to make a reasonable assumption; `llm` consults the controller's model at extra token cost. After 10 successful LLM answers, the next question goes to the user, then the budget resets. Unavailable LLM answers or dismissed/unavailable escalation prompts fall back to `deny`.

## Sandbox setup

Authorize the installed runtime, task files, transcript directory, worktree paths (including shared Git metadata), and socket subtree before starting the controller. Policy changes require a new sandbox process, not just `/reload`.

Set `PI_SUBAGENT_SOCKET_ROOT` to an existing, absolute, user-owned private directory (mode `0700`), and authorize socket bind/connect beneath it. An invalid or overlong configured root fails without fallback. Without an override, unsandboxed and Linux launches use the OS temporary directory. If socket paths exceed platform limits, choose a shorter permitted root. Abrupt controller death can leave orphaned socket directories.

For a wrapper smoke test, run `node pi/extensions/subagent/tests/sandbox-smoke.mjs /absolute/path/to/bin/pi` from the repository root (or supply your unsandboxed wrapper). It uses a deterministic provider without paid model calls and retains diagnostic artifacts. It does not test sandbox denial or proxy endpoint access; forced-crash recovery and the sandboxed linked-worktree/subdirectory matrix remain unverified.

## State and inspection

Task artifacts live at `${XDG_STATE_HOME:-~/.local/state}/pi/subagent/<task_id>/`. Useful files include `result.json` (saved result), `bus.jsonl` (communication log), `stdout.log`, `stderr.log`, and the child's prompt/task inputs. Use `tail -F` on logs for inspection outside Pi; there is no interactive child TUI. Stale tasks whose recorded processes are gone are marked `crashed` on session start.

Durable transcripts live separately under `$PI_CODING_AGENT_DIR/subagent-sessions/<task_id>/` (default `~/.pi/agent/subagent-sessions/<task_id>/`). They contain potentially sensitive messages and tool output, use private permissions, and are not uploaded automatically. Grant sandbox access to this subtree, not the entire agent directory. Transcripts are excluded from normal resume listings but can be opened with `pi --session <path-to-jsonl>`.

`subagent_status` lists active tasks and ten recent completed tasks, including previous sessions. `limit` accepts 0-50; 0 lists active tasks only. Supply `task_id` for the full report. Large results return a marked preview and a path to the complete saved result; storage/retrieval failures are reported explicitly.

Deleting task directories removes report history but not transcripts or their `/total-cost` contributions. Deleting transcripts removes those costs. Older task-local transcripts require explicit migration to the durable directory to contribute; ephemeral runs cannot be reconstructed from bus logs.

## Interpreting results

`status` describes the harness lifecycle, not task fulfillment: `ok` alone does not mean the request was fulfilled. Use `taskOutcome`, `resultDescription`, `remaining`, and `blockers` to understand what was delivered. Only controller-finalized results are authoritative about retention and cleanup; a child's final report is still provisional until then.

Results distinguish child-reported artifacts/checks from harness-observed retention and cleanup. The harness does not independently rerun the child's checks. Inspect `finalReport.data` as well as the summary; it can hold the actual deliverable. See the [skill](../../skills/subagent/SKILL.md#reading-the-report) for report-handling guidance.

Progress stays in the UI and logs; only finalized completion notifies the main model. Summarize the substantive outcome once, not each lifecycle event. Retrieve the full result when needed, not merely to acknowledge an already-handled notification.

## Worktree handling

Isolated tasks start on detached HEAD under `<source-worktree-root>/.agent-worktrees/<task_id>/`. Configure `.agent-worktrees/` in your global Git ignore file; the extension does not edit ignore settings. An empty `git branch --show-current` is expected: do not create or switch branches to "fix" it.

After the child exits, committed output is retained on `subagent/<agent>/<task_id>` before removing the worktree. Existing branches are never overwritten. If the child explicitly reports `completed`, remaining uncommitted changes are committed by the harness; otherwise they are left untouched and the worktree is preserved. Retention or cleanup failures are reported, with preserved paths where available. The main agent decides whether to merge, open a PR, or abandon the retained branch.

## Limitations and tests

- A dropped communication socket terminates the task; reconnection is not supported.
- Children cannot recursively delegate.
- Prompt-only restrictions are not security boundaries, and children share the controller's proxy capabilities.

Run `node pi/extensions/subagent/tests/run.mjs` from the repository root. The suite uses an in-memory provider without network requests or credentials; real sandbox/proxy compatibility needs separate checks.
