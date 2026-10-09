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

It also emits lifecycle events on `pi.events`: `subagent:spawned`, `subagent:connected`, `subagent:progress`, `subagent:report`, `subagent:finalizing`, `subagent:asked`, `subagent:answered`, `subagent:steered`, `subagent:done`, `subagent:failed`. The namespace is singular to coexist with `@tintinweb/pi-subagents`' plural `subagents:*` namespace.

## Model selection

Each subagent inherits the main agent's active provider, model, and thinking level at dispatch time, passed explicitly via `--provider`, `--model`, and `--thinking`. Changing the main agent's settings affects subsequent spawns, not already-running subagents. If the main context has no model, the child uses Pi's normal model selection. Pi may clamp thinking to the selected model's supported levels; exact child-side verification is part of the planned state handoff.

Generic extension state and approval delegation are not implemented yet. In particular, OCR approvals remain local to the controlling session; headless children cannot inherit them yet.

## Runtime and inherited environment

Subagents invoke the controlling process's interpreter and canonical installed Pi CLI with `-p`, with stdin closed and stdout/stderr redirected to private task logs. The entrypoint must match the Pi package's declared CLI; runtime identification or execution failure stops launch without a PATH fallback. Installed Node/Bun CLI distributions are supported; SDK hosts, source entrypoints not declared in the package manifest, and standalone compiled binaries are not supported by this resolver.

Direct children inherit the controller's environment and OS sandbox, even though each child has its own process group. A sandboxed controller produces sandboxed children; an unsandboxed controller produces unsandboxed children. Children do not rerun nono or proxy bootstrap wrappers, obtain independent proxy leases, or escape the parent's restrictions. The parent wrapper must authorize the task-specific socket subtree, task files, worktree paths, and installed runtime. No tmux socket grant or additional wrapper execution grant is needed.

Both sandboxed and `pi-naked` children share the controller's proxy environment and lease lifetime. The controller owns their lifetime and cancels them at shutdown; a background subagent is not an independently leased session. Proxy access cannot be revoked separately for one child through this shared transport. Environment inheritance is not generic extension-state or approval delegation, which remains unimplemented. Start a fresh updated controller after changing these wrappers or the extension; old tmux-based controllers do not provide these inheritance guarantees.

### Socket placement

Set `PI_SUBAGENT_SOCKET_ROOT` to an existing, absolute, user-owned private directory (0700). The launcher must create it before sandbox startup and authorize socket bind/connect beneath it. Dotfiles commit `5a97ebeb0017` supplies `$TMPDIR/pi-sockets` and nono's `filesystem.unix_socket_subtree_bind` grant. The extension allocates a unique private `p-XXXXXX` directory there and uses `s` as the socket filename. An explicitly configured invalid, inaccessible, or overlong root fails without falling back elsewhere.

Without that variable, unsandboxed and Linux launches allocate private per-task directories directly under the OS temporary directory. Paths are checked in UTF-8 bytes before bind/connect: at most 103 bytes on macOS (and conservatively on other POSIX systems), or 107 on Linux, reserving space for the terminating NUL. Choose a shorter permitted root if even this path is too long; artifact paths do not need shortening.

`PI_SUBAGENT_SOCKET_PATH` carries the exact allocated path to the child. The child does not derive it from its root or state directory, and rejects missing or invalid bootstrap paths before submitting a model request. `PI_SUBAGENT_BUS_DIR` still names the retained artifact directory. Closing the controller's transport removes its socket directory; launch failures also clean up that allocation. Cleanup is nonrecursive, verifies the allocated directory's identity, and never removes the shared root. Unexpected contents or cleanup failures are reported rather than removed recursively. Abrupt controller death such as SIGKILL can leave an orphaned socket directory; disk history does not authorize sweeping other allocations.

### Wrapper smoke test

Run `node pi/extensions/subagent/tests/sandbox-smoke.mjs /absolute/path/to/bin/pi` explicitly (or pass `bin/pi-naked` for an unsandboxed controller). It uses an isolated temporary Pi configuration and a deterministic provider, with no paid model calls. Only the controller uses the real wrapper; the test checks that its direct child uses the same installed runtime and socket root, plus progress/clarification/report delivery, process-group exit, socket cleanup, and retained results. Logs and task artifacts are kept for diagnosis. It does not alter sandbox permissions or substitute a runtime after failure; it does not itself test sandbox denial or proxy endpoint access.

The initial recursive-wrapper macOS smoke bound the socket successfully but failed at child wrapper access, then at nested nono policy reconstruction. Direct inherited children avoid that bootstrap. Subsequent manual macOS checks passed scout execution, worker commit retention, cancellation, denied access, and normal controller shutdown with a child and tool descendant. The retained worker branch, commit contents, saved result, and absent worktree directory/registration were independently checked. Forced SIGKILL/crash recovery and the broader sandboxed linked-worktree/subdirectory matrix remain unverified.

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
- `bus.jsonl`: append-only audit log of every envelope in both directions
- `system-prompt.md`: the rendered system prompt the subagent was given
- `task.txt` / `run.sh`: wrapper artifacts written by the spawner
- `stdout.log` / `stderr.log`: child output and diagnostics (mode `0600`)
- `worktree`: symlink to the isolated worktree, when `worktree: true`

On session start, stale entries whose recorded pids are gone are marked `crashed` automatically.

## Results and completed-task history

Synchronous final tool results and per-task `subagent_status` responses include model-visible status, full task ID, artifact paths, worktree outcome, and the full `finalReport`: summary, findings, branch/commits, and arbitrary `data`. Background completion messages are short digests with a task ID and result path; retrieve the full report with `subagent_status` if the finalized result has not already been observed. If saving fails, the completion message still carries the full bounded result so finalization details are not lost. The UI's `details` object is not the model-facing interface. Task-specific deliverables can live under `finalReport.data`, not just `summary`.

Large results produce an explicitly marked preview (32,000 characters of result data plus identity/path information) and a path to the full saved result. If persistence fails, the result still includes the report and a diagnostic; the audit log remains the fallback inspection surface.

`subagent_status` without arguments lists this controller's active tasks and ten recent completed tasks from the local state directory, including previous sessions. `limit` selects 0 to 50 completed tasks; 0 means active only. Listings provide IDs, brief summaries, and paths. `subagent_status({task_id: "..."})` retrieves the full result for an active or completed task. Older tasks without a saved result can recover their report from the audit log; missing/corrupt artifacts produce an explicit diagnostic rather than hiding the task. Pruning task directories removes their history as well.

### Lifecycle, task fulfillment, and evidence

`status` describes the harness lifecycle, not whether the request was fulfilled. After child settlement it remains `finalizing` until commit retention, cleanup, and result handling finish. `finalized: false` marks provisional results; a child's `final: true` report is not a controller completion notification.

Children can report `outcome` as `completed`, `partial`, `blocked`, `declined`, `failed`, or `unknown`, with a descriptive `summary`, `remaining`, `blockers`, `artifacts`, and `verification`. Final tool results expose that claim as `taskOutcome` alongside a human-readable `resultDescription`. Missing outcomes are `unknown`; neither a zero exit code nor prose is converted into a completion claim. `execution` records child completion/exit separately, so a reported completed task can still have a failed harness lifecycle when retention fails.

Artifacts have `kind`, `location`, and optional `description`. Verification entries have `check`, `result` (`passed`, `failed`, or `not_run`), and optional `details`. Results separate `artifacts.reported` from `artifacts.retained`, and `verification.reported` from `verification.harness`. The controller verifies process completion, Git inventory, branch retention, and worktree cleanup; it does not independently rerun the child's checks. A completed testing task can legitimately report failing tests. Saved snapshots retain the raw `details` and derived `result` description.

Background report notifications are marked not finalized. Completion notifications lead with a bounded result description, followed by lifecycle/outcome, retained branch or preserved path when available, and a retrieval pointer. They do not repeat the full artifacts and verification tables. Already-queued notifications are not retracted when a status query observes completion first.

Workers remain commit-producing agents even with `worktree: false`. A no-commit request should be declined without edits and with an explicit reason; use the main agent or a custom non-committing agent instead.

## Watching progress

The controlling UI shows a running-task count and a compact progress widget. Synchronous calls also stream progress/report updates in the tool result; background reports and completion arrive as user messages. `subagent_status` exposes each active task's pid and log paths.

For inspection outside Pi, use `tail -F` on the task's `bus.jsonl`, `stdout.log`, or `stderr.log`. Logs remain after the child exits, including on failure. There is no interactive child TUI or attach viewer in this increment.

## Worktree handling

For `worktree: true` agents (case 2), the extension:

1. Creates `<source-worktree-root>/.agent-worktrees/<task_id>/`, including when the source is itself a linked worktree. Requests from a subdirectory use that checkout's root.
2. Records the starting commit and runs `git worktree add --detach` against that exact commit.
3. Sets the subagent's cwd to that worktree.
4. After the subagent exits:
   - Detects commits since the recorded starting commit, even if the worker committed everything and left a clean checkout. Later changes to the parent's HEAD do not change that baseline.
   - If uncommitted changes exist and the child explicitly reported `completed`: stages and commits with `subagent(<agent>): <truncated task>`. Otherwise leaves uncommitted work untouched and preserves the worktree, while still retaining any existing commits.
   - Creates and verifies branch `subagent/<agent>/<task_id>` for committed output before removing the worktree. Existing branches are never overwritten.
   - Only a clean checkout with no new commits is treated as a no-op.
   - If reported commit IDs disagree with Git's detected commits, or retention/cleanup fails: reports failure and preserves the worktree when present. Detected commits and the retained branch remain visible under `worktree`; the child's original `finalReport` is not overwritten.

Configure `.agent-worktrees/` in your global Git ignore file before using isolated workers. The extension does not edit your ignore configuration. Keeping worktrees inside the source checkout avoids a sibling-directory write outside a repository-scoped sandbox grant; access to shared Git metadata and the task files/socket still needs validation, especially when the source is a linked worktree or the sandbox starts in a subdirectory.

An isolated worker starts on detached HEAD and commits there. An empty `git branch --show-current` is expected, not a setup failure: the harness creates the retained branch after the worker exits. Do not create or switch branches merely to make that command nonempty. The branch is the artefact; the worktree directory is internal. The main agent decides whether to merge, PR, or abandon.

New results replace the ambiguous `worktree.hasChanges` with `hasCommittedChanges` (new commits since the starting commit, including any harness-created commit) and `hadUncommittedChanges` (dirty files observed at the start of finalization). These describe output history, not whether a worktree currently exists. A clean, removed checkout can have `hasCommittedChanges: true` and `hadUncommittedChanges: false`; `null` means the inventory was not established.

Cleanup is independently observed during controller finalization: `worktree.cleanup.directoryRemoved` checks the directory, while `worktree.cleanup.registrationRemoved` queries Git's worktree registrations. `false` records a remaining directory/registration, including intentionally preserved work; `null` means the check could not establish the state. `execution.processExited` records an observed child exit; `execution.processGroupExited` records whether the owned process group passed the disappearance check. Exit code and signal remain separate. Missing fields in older snapshots do not prove successful cleanup, and shared-cwd tasks have no worktree cleanup object.

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
    description.ts          # task fulfillment, result narrative, artifacts/evidence
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
