---
description: Run a sweep of worker subagents in parallel worktrees to make the same kind of change in many places.
---

# Sweep workflow

You will run a campaign of focused changes across multiple locations. For each location, you will spawn a `worker` subagent in an isolated worktree (`worktree: true`, which is the worker's default). Each worker produces one branch.

User request: $ARGUMENTS

Steps:

1. **Scout the targets.** Use the `subagent` tool with `agent: scout` to identify the list of locations that need changing. Be specific: each target should be a self-contained change a worker can complete independently. Aim for 3 to 20 targets; more than that is a planning failure.
2. **Confirm with the user.** Summarize the targets you found and ask whether to proceed. Do NOT skip this step.
3. **Launch workers.** For each target, call the `subagent` tool with `agent: worker` and a precise per-target task. By default workers run synchronously (one at a time) which keeps the main session predictable; if the user explicitly wants parallelism, add `background: true` to each call.
4. **Collect.** As each worker reports back, accumulate its branch name and commits. If a worker fails, note that and decide (with the user) whether to retry, skip, or abort.
5. **Summarize.** Once all workers have reported, produce a single final summary listing branches created, commits, and any failures. Suggest next steps (open PRs? merge sequentially?) but don't take them automatically.

Keep the user informed throughout. Workers running in worktrees do not affect the main working tree; the user can switch to a worker's tmux window/pane to watch a specific worker's progress.
