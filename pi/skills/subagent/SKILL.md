---
name: subagent
description: Delegate focused work to specialized subagents (scout, linter, tester, reviewer, formatter, worker) that run in their own pi processes inside tmux panes. Use when you need read-only investigation, lint/test/review of current work, or sweeping changes across many locations that should each produce their own commit.
---

# subagent

Delegate work to a focused subagent. Each subagent is a separate pi process running in a tmux pane (split or window), with its own narrower system prompt and tool whitelist. They report back via structured envelopes.

The `subagent` tool spawns a subagent; the `subagent_steer`, `subagent_cancel`, and `subagent_status` tools manage in-flight subagents.

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

Defaults that fit: `worktree: false`, `placement: split-right`, `close_on_success: true`. All built-in case-1 agents (`scout`, `linter`, `tester`, `reviewer`, `formatter`) already set these.

Useful fan-out idiom: launch several case-1 helpers in a single assistant turn. When the active model supports parallel tool calls, multiple `subagent` calls emitted in the same response run concurrently, each in its own pane.

### Case 2: worktree per worker

The user wants the same kind of change made in many places, each producing its own commit and (later) its own PR. The `worker` agent handles this. Defaults: `worktree: true`, `placement: window-detached`, `close_on_success: false`. The extension provisions an isolated worktree per call, lets the worker commit, and binds the commits to a branch named `subagent/worker/<short_task_id>` in the main repo. The worktree itself is pruned; the branch is the artefact.

For a campaign of multiple workers, see the `/sweep` workflow prompt: scout out targets, confirm with the user, then call `subagent` once per target. Sequential (default) is safer; add `background: true` per call if the user explicitly wants parallelism.

## Picking an agent

| Want to...                                                  | Use         |
| ----------------------------------------------------------- | ----------- |
| Find code, understand structure                             | `scout`     |
| Run the project's linter and surface diagnostics            | `linter`    |
| Run the test suite and surface failures                     | `tester`    |
| Get a second opinion on a diff or scope                     | `reviewer`  |
| Run the formatter and have it write changes                 | `formatter` |
| Implement a scoped change in isolation, with its own branch | `worker`    |

If none of these fits, define a new agent at `pi/extensions/subagent/agents/<name>.md` (in this repo) with frontmatter (`description`, `tools`, optional `placement`/`worktree`/`close_on_success`/`disallowed_tools`/`ask_policy`) and a system prompt body.

## How subagents ask clarifying questions (`ask_policy`)

Subagents can call their `ask` tool to request clarification mid-task. The main side answers the question one of three ways, controlled by `ask_policy`:

| Policy  | What happens when the subagent asks                                                                                    | When to use                                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human` | The watching user gets a TUI input prompt. Whatever they type is the answer.                                           | **Default.** Right for case-1 helpers in a visible split where the user is at the keyboard and a single popup is fine.                                               |
| `deny`  | No one is consulted. The subagent gets a canned reply telling it to make a reasonable assumption and document it.      | Unattended or high-fan-out work where popups would be intrusive (e.g. a sweep of background workers). Already the default for the bundled `worker` agent.            |
| `llm`   | The question is forwarded to the main agent's own model via a one-shot out-of-band call. The reply is sent on the bus. | Background or parallel work where you want better-than-deny answer quality without bothering the user. Costs extra tokens per ask; adds latency. Use when justified. |

Precedence: the per-call `ask_policy` argument to the `subagent` tool wins; if absent, the agent .md frontmatter wins; if absent there too, the global default `human` applies.

Practical guidance for choosing:

- Single visible helper, user is watching: leave it alone (`human`).
- A `worker` (especially via `/sweep`): leave it alone (`worker`'s frontmatter already sets `deny`).
- `background: true` task you launched while the user is doing something else: prefer `deny` unless the work is high-value enough to justify `llm` round-trips.
- You want the subagent to clarify with "the same brain that delegated the task" rather than the user: `llm`.

If you set `llm` and the main agent has no model configured or the API call fails, the system falls back to the `deny` behaviour automatically (and emits `subagent:answered` with `source: "llm-fallback"`).

### Budget and human escalation

The `llm` policy is gated by a per-task budget of 10 successful LLM-answered questions. On the 11th question, the next ask is escalated to a `human` prompt regardless of policy: the user gets a TUI input dialog so they can sanity-check that the subagent has not drifted. The counter then resets, and the subagent gets another 10 LLM-answered questions before the next check-in. If the user dismisses the escalation (Esc / empty input / no UI available), the subagent receives the deny-style canned reply (`source: "policy-escalated"`) and the counter still resets, so the user is not re-prompted on every subsequent question. Only successful `'llm'`-answered asks count toward the budget; fallbacks (`source: "llm-fallback"`) do not.

## Reading the report

Every subagent returns an `AgentToolResult`. The `details` payload is the structured part you should reason about:

- `details.status`: one of `ok`, `failed`, `aborted`, `crashed`. Anything other than `ok` deserves scrutiny.
- `details.finalReport.summary`: the subagent's one-line summary. Surface this to the user.
- `details.finalReport.findings`: structured items (file, line, severity, message). For lint/test/review, act on these.
- `details.finalReport.branch` + `details.finalReport.commits`: for `worker` subagents, the branch the work landed on and the commits it contains.
- `details.worktree.preservedPath`: if a worker failed mid-task, the worktree was kept for inspection at this path.

When a subagent reports findings, decide whether to:

- Fix and move on (most case-1 lint/format)
- Surface to the user and ask (when findings are subjective)
- Stop and reconsider (when a reviewer flags a serious bug)

## Steering and cancellation

If a subagent is going off course, use `subagent_steer` with `text` containing a redirection ("focus on src/auth/ only", "ignore deprecated callers"). The steer is injected into the subagent's session as a synthetic user message.

If a subagent is stuck or wrong-headed, use `subagent_cancel`. Graceful by default (sends a cancel envelope, gives the subagent a chance to wrap up), escalates to SIGTERM then SIGKILL.

Don't cancel impatiently: subagents are real processes consuming real tokens, and a partial report is more useful than a hard kill.

## Etiquette

- **Confirm before launching a `worker`.** Workers commit. The user should know what you're about to commit on their behalf.
- **Summarize after subagent reports.** Don't just hand the raw findings to the user; synthesize.
- **One subagent per task scope.** Don't load multiple unrelated tasks into one subagent's prompt; the LLM context is the constraint.
- **Watch for `status` other than `ok`.** Crashes and aborts deserve a sentence to the user explaining what happened.
