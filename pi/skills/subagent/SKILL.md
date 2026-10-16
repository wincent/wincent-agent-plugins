---
name: subagent
description: Delegate focused work to specialized subagents (scout, linter, tester, reviewer, formatter, worker) that run in their own headless pi processes. Use when you need read-only investigation, lint/test/review of current work, or sweeping changes across many locations that should each produce their own commit.
---

# subagent

Delegate focused work to a headless Pi subagent with its own prompt and tool whitelist. Provider, model, and thinking level are inherited at dispatch. Progress appears in the controlling UI; reports and private logs remain available after completion.

The `subagent` tool spawns a subagent; `subagent_steer` and `subagent_cancel` manage in-flight tasks. `subagent_status` lists active/recent completed tasks and retrieves their reports.

## Execution mode: background by default

**Always launch subagents in the background unless the user explicitly requests synchronous execution.** Omit `background` (the runtime default is `true`) or set `background: true`. Set `background: false` only in response to that explicit instruction. This applies to every agent, including a single helper and each worker in a sweep. A short task, a dependency on its result, or a request to run workers sequentially is not an instruction to block the conversation.

After dispatch, continue independent work or yield the turn so the user can keep talking. Completion arrives automatically; do not busy-poll `subagent_status`, sleep-loop, or otherwise block merely to wait. When the next step depends on a subagent, leave that step pending until its completion notification, then retrieve any needed report details and continue. Acknowledge that work is still running rather than implying it is complete.

Background execution is separate from concurrency. For sequential work, launch one background task and start the next after its predecessor finishes. Only overlap independent work, and avoid editing files that a shared-cwd formatter or other writing helper is modifying. Do not change the code under review or test while relying on that helper's results as validation of the same snapshot.

## When to delegate

Use a subagent when ALL of:

1. The work is **separable** from your current main thread of reasoning. If you'd otherwise context-switch, that's a hint.
2. It either needs **isolation** (case 2: sweeping changes that should each produce a branch) or **focus** (case 1: a specialized helper with a narrow tool set, e.g. read-only review).
3. The cost is justified. Each subagent is a fresh pi process and a fresh LLM context window; don't delegate something you could do in a single tool call.

**DO NOT** delegate:

- Trivial single-tool work (running one bash command, reading one file).
- Anything that requires tight back-and-forth with the user; the user is talking to YOU.
- Work that depends on the full main-session context that the subagent won't have.

## Two patterns

### Case 1: shared cwd, fast helpers

The main agent (you) is working on a single change. You delegate side tasks to short-lived helpers that read the working tree, do their job, and report findings. The main pattern:

> "Use the `reviewer` to look at my changes against main and report any concerns. Then use the `linter` to make sure lint is clean. If either reports issues, fix them and continue."

All built-in case-1 agents (`scout`, `linter`, `tester`, `reviewer`, `formatter`) use `worktree: false`. Children exit when finished; logs are retained.

Useful fan-out idiom: launch several independent case-1 helpers in a single assistant turn. Background calls return after startup, so helpers can overlap even when the tool calls themselves are dispatched sequentially. Each helper runs in its own process.

### Case 2: worktree per worker

The user wants the same kind of change made in many places, each producing its own commit and (later) its own PR. The `worker` agent handles this. Workers are commit-producing agents; `worktree: false` disables isolation but does not enable a no-commit mode. For untracked-only edits, use the main agent or a custom non-committing agent. Default: `worktree: true`. The extension provisions an isolated worktree per call under `<source-worktree-root>/.agent-worktrees/<task_id>/`, lets the worker commit, and binds the commits to a branch named `subagent/worker/<task_id>` in the shared repository. Configure `.agent-worktrees/` in your global Git ignore file; the harness does not modify ignore settings. The worker starts on detached HEAD and commits there; an empty `git branch --show-current` is normal. The harness creates the retained branch only after the worker exits. Do not treat the empty branch name as a failure or ask the worker to create a branch to fix it. The worktree itself is pruned; the branch is the artefact.

For a campaign of multiple workers, see the `/sweep` workflow prompt: scout out targets, confirm with the user, then call `subagent` once per target. Launch each worker in the background. Sequential scheduling remains the default for a campaign: start the next worker after the previous one completes, without blocking the conversation. If the user requests parallel workers, overlap independent targets; this is separate from the `background` setting.

## Picking an agent

| Want to...                                                  | Use         |
| ----------------------------------------------------------- | ----------- |
| Find code, understand structure                             | `scout`     |
| Run the project's linter and surface diagnostics            | `linter`    |
| Run the test suite and surface failures                     | `tester`    |
| Get a second opinion on a diff or scope                     | `reviewer`  |
| Run the formatter and have it write changes                 | `formatter` |
| Implement a scoped change in isolation, with its own branch | `worker`    |

If none of these fits, define a new agent at `pi/extensions/subagent/agents/<name>.md` (in this repo) with frontmatter (`description`, `tools`, optional `worktree`/`disallowed_tools`/`ask_policy`) and a system prompt body.

## How subagents ask clarifying questions (`ask_policy`)

Subagents can call their `ask` tool to request clarification mid-task. The main side answers the question one of three ways, controlled by `ask_policy`:

| Policy  | What happens when the subagent asks                                                                                    | When to use                                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human` | The watching user gets a TUI input prompt. Whatever they type is the answer.                                           | **Default.** Right for case-1 helpers when the user is watching the controlling UI and a single popup is fine.                                                       |
| `deny`  | No one is consulted. The subagent gets a canned reply telling it to make a reasonable assumption and document it.      | Unattended or high-fan-out work where popups would be intrusive (e.g. a sweep of background workers). Already the default for the bundled `worker` agent.            |
| `llm`   | The question is forwarded to the main agent's own model via a one-shot out-of-band call. The reply is sent on the bus. | Background or parallel work where you want better-than-deny answer quality without bothering the user. Costs extra tokens per ask; adds latency. Use when justified. |

Precedence: the per-call `ask_policy` argument to the `subagent` tool wins; if absent, the agent .md frontmatter wins; if absent there too, the global default `human` applies.

Practical guidance for choosing:

- Single helper, user is watching the controlling UI: leave it alone (`human`).
- A `worker` (especially via `/sweep`): leave it alone (`worker`'s frontmatter already sets `deny`).
- `background: true` task you launched while the user is doing something else: prefer `deny` unless the work is high-value enough to justify `llm` round-trips.
- You want the subagent to clarify with "the same brain that delegated the task" rather than the user: `llm`.

Unavailable LLM answers fall back to `deny`. After 10 successful LLM answers per task, the next question goes to the user, then the budget resets. Dismissed or unavailable escalation prompts fall back to `deny` too; `llm` is not a guarantee of unattended execution.

## Reading the report

The final tool result includes model-visible JSON. Read that content, not just the UI's `details` object, which is not necessarily sent to the model. Background completion is a short digest with task ID and result path; retrieve the full report through `subagent_status` when needed for findings, verification, artifacts, or deliverables. Do not retrieve it merely to acknowledge a self-contained diagnostic result. If you already retrieved the finalized result, do not fetch it again because a notification arrived.

Progress and provisional reports stay in the UI and logs; only finalized completion notifies the main model. Summarize the substantive outcome once, not each lifecycle event. Ignore late or duplicate notifications unless they add actionable information.

- `taskId`, `status`, and `finalized`: identify the task and harness lifecycle. `running` and `finalizing` are nonterminal. Only the controller's final result is authoritative about retention and cleanup. A background dispatch initially returns a handle, not a completed report. `status: "ok"` alone does not mean the user's request was fulfilled.
- `taskOutcome`: the child's explicit final outcome: `completed`, `partial`, `blocked`, `declined`, `failed`, or `unknown`. Missing or interim-only outcomes remain `unknown`, even with a normal exit or success-sounding summary.
- `resultDescription`, `remaining`, and `blockers`: what was delivered, what is still missing, and why work stopped. Lead the user-facing summary with this information, not a bare `ok`.
- `artifacts.reported` versus `artifacts.retained`: child-reported output locations versus harness-observed retained branches, commits, or preserved worktrees. A reported file inside a removed worktree is not necessarily a live filesystem path; use its retained commit/branch to inspect it.
- `verification.reported` versus `verification.harness`: child-reported checks versus checks the controller actually performed. Each has `check`, `result` (`passed`, `failed`, or `not_run`), and optional evidence in `details`. Do not promote a child claim into independent verification. A testing task can be completed while reporting failing tests.
- `execution` and `worktree.cleanup`: inspect process exit, retained work, and cleanup separately. An absent directory does not prove Git-registration removal; preserved work is not necessarily a cleanup failure. `null` means unverified.
- `worktree.hasCommittedChanges` and `worktree.hadUncommittedChanges`: commits since launch and dirty files at finalization, not whether a worktree currently exists.
- `finalReport.summary`: the subagent's short summary. It is not necessarily the complete answer.
- `finalReport.findings`: structured items (file, line, severity, message). For lint/test/review, act on these.
- `finalReport.branch` + `finalReport.commits`: the child's original claims. For isolated workers, `worktree.branch` and `worktree.commits` contain the controller's detected/retained output; discrepancies are explicit failures, not silently rewritten reports.
- `finalReport.data`: inspect this before answering; it may hold the actual deliverable rather than the summary. Do not confuse arbitrary records here with `finalReport.commits`, which describes worker-produced commits.
- `worktree.preservedPath`: if a worker failed mid-task, the worktree was kept for inspection at this path.
- `taskDir`, `resultPath`, `stdoutPath`, `stderrPath`, and `auditLogPath`: artifact locations for later inspection.

Large results include a truncation notice and artifact path; read the artifact for omitted data. Storage/retrieval failures appear in `retrievalNote`. A child's final report is not proof that retention or cleanup has finished.

When a subagent reports findings, decide whether to:

- Fix and move on (most case-1 lint/format)
- Surface to the user and ask (when findings are subjective)
- Stop and reconsider (when a reviewer flags a serious bug)

## Inspection

Call `subagent_status` without arguments to list this controller's active tasks and the ten most recent completed tasks in the local state directory, including tasks from previous sessions. Use `limit` (0 to 50) to change the number of completed tasks; `limit: 0` lists only active tasks. Listings contain IDs, short summaries, and artifact paths, not every report's full contents.

Call `subagent_status` with `task_id` to retrieve the full result, including `finalReport.data`, after completion or a session restart. Do not search the parent session transcript to recover report data. Task artifacts remain unless explicitly pruned; there is no interactive child pane.

Children inherit the controller's environment, sandbox, and proxy lifetime, not independent permissions or leases. See the [extension README](../../extensions/subagent/README.md#sandbox-setup) for sandbox setup and troubleshooting.

OCR approval is inherited by subsequently launched children when OCR is loaded and allowed. Later grants/revocations do not reach existing children. Other approvals require explicit extension support; headless tools needing local UI approval may fail. An LLM answer to `ask` is not authorization, and inherited state must never be forged.

A one-shot headless controller cancels background children when its session ends; background dispatch does not keep it alive. There is no automatic synchronous fallback. The caller must keep the controlling session alive until completion or explicitly request synchronous delegation (`background: false`). Without either arrangement, do the work in the main agent or explain the limitation rather than spawning a task that will be cancelled at exit. Do not infer permission for synchronous execution merely from headless mode.

## Steering and cancellation

Use `subagent_steer` with a `text` redirection if a subagent goes off course. Use `subagent_cancel` if it is stuck or wrong-headed; cancellation starts gracefully, then escalates to SIGTERM/SIGKILL.

Don't cancel impatiently: subagents are real processes consuming real tokens, and a partial report is more useful than a hard kill.

## Etiquette

- **Confirm before launching a `worker`.** Workers commit. The user should know what you're about to commit on their behalf.
- **Summarize substantive completion once.** Don't just hand the raw findings to the user; synthesize. Avoid lifecycle acknowledgments and repeated summaries. Surface intermediate information only when the user asks or it requires action.
- **One subagent per task scope.** Don't load multiple unrelated tasks into one subagent's prompt; the LLM context is the constraint.
- **Watch for `status` other than `ok`.** Crashes and aborts deserve a sentence to the user explaining what happened.
