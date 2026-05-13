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

## Type-checking

A `tsconfig.json` sits alongside the extensions so that `tsgo` (or `tsc`) can resolve the platform packages (`@earendil-works/pi-*`, `typebox`, `@types/node`). The matching `.d.ts` stubs live under `node_modules/`, populated on demand by `bin/install-types` (which copies them out of the globally-installed pi). We assume Pi is globally installed; Pi extensions will use the globally-installed versions of their dependencies[^jiti].

[^jiti]: Pi's loader (see `dist/core/extensions/loader.js` in the global install) loads extensions with jiti, passing a map that rewrites the specifiers to absolute paths before Node's module resolution kicks in. This means that it will always use the globally installed dependencies and won't try to load anything from the local `node_modules` directory.

The stub tree is _not_ committed: each pi release would otherwise produce a thousand-file regeneration diff that buries everything else in the history, and the bulk of the tree (`@types/node`, `typebox`) is third-party content that has no business living in this repo. The `node_modules/` directory itself is tracked, but only to anchor a `.gitignore` that ignores everything underneath it; the stubs themselves are produced locally as needed.

- Run a check from the repo root with `bin/typecheck`. If the stubs are missing (fresh checkout, or you wiped them) it will call `bin/install-types` for you automatically before invoking `tsgo`.
- Refresh the stubs manually after each pi upgrade with `bin/install-types`. The script does not detect version drift on its own, so a stale tree will type-check against the previous pi's API surface until you rerun it.

`npm install` is intentionally blocked in this directory because the runtime dependency trees of the platform packages, in particular `@earendil-works/pi-ai`, pull in every supported provider SDK (Anthropic, AWS Bedrock, Google, Mistral, OpenAI) and their transitive trees. None of that is needed to type-check a handful of extension files, and at least one transitive dependency (`@mistralai/mistralai`) has been the target of supply chain attacks in the past ([MAL-2026-3432](https://osv.dev/vulnerability/MAL-2026-3432)/[GHSA-3q49-cfcf-g5fm](https://github.com/advisories/GHSA-3q49-cfcf-g5fm)).

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
