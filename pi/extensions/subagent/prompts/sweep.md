---
description: Run a sweep of worker subagents in parallel worktrees to make the same kind of change in many places.
---

# Sweep workflow

You will run a campaign of focused changes across multiple locations. For each location, you will spawn a `worker` subagent in an isolated worktree (`worktree: true`, which is the worker's default). Each worker produces one branch.

User request: $ARGUMENTS

Steps:

1. **Scout the targets.** Use the `subagent` tool with `agent: scout` to identify the list of locations that need changing. Launch in the background (the default), and yield the turn or continue independent work until completion arrives. Be specific: each target should be a self-contained change a worker can complete independently. Aim for 3 to 20 targets; more than that is a planning failure.
2. **Confirm with the user.** Summarize the targets you found and ask whether to proceed. Do NOT skip this step.
3. **Launch workers.** For each target, call the `subagent` tool with `agent: worker` and a precise per-target task. Launch each worker in the background (omit `background` or set it to `true`). Schedule one worker at a time by default, launching the next after the previous worker completes; if the user requests parallelism, overlap independent targets. Sequential scheduling does not mean synchronous execution. Set `background: false` only when the user explicitly requests synchronous execution, never merely because a later step needs the result.
4. **Collect.** As each worker reports back, accumulate its branch name and commits. If a worker fails, note that and decide (with the user) whether to retry, skip, or abort.
5. **Summarize.** Once all workers have reported, produce a single final summary listing branches created, commits, and any failures. Suggest next steps (open PRs? merge sequentially?) but don't take them automatically.

Keep the user informed throughout. While a subagent is running, continue independent work or yield the turn so the conversation stays available. Do not busy-poll or sleep-loop waiting for reports; completion notifications arrive automatically. Workers running in worktrees do not affect the main working tree; the user can watch the controlling UI's progress widget or inspect a worker's task logs. A one-shot headless controller must be kept alive until completion or receive an explicit request for synchronous delegation; otherwise, explain the lifetime limitation instead of launching workers that shutdown will cancel.
