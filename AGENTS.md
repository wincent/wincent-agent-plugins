# Agent instructions

## Formatting checks before committing

Before creating any commit, run `bin/check-format` to see whether any files need formatting fixes. If fixes are needed, run `bin/format` to apply them, then include the resulting changes in the commit.

## Directory structure

The top level of this repository contains two agent-specific directories:

- `claude/` holds one subdirectory per Claude plugin, each of which contains one or more Claude skills.
- `pi/` (and more specifically, `pi/skills/`) is a compatibility layer for Pi, containing symlinks into `claude/<plugin>/skills/<skill>` (plus a small number of real directories for Pi-only skills).

One motivation for the symlinks is that Claude plugins effectively serve as namespaces (a skill's fully-qualified name is scoped to its plugin), but Pi has no namespacing mechanism. The symlinks under `pi/skills/` give each exposed skill a unique, flat name that Pi can use.

In addition to `pi/skills/`, the `pi/` directory contains two other directories of interest:

- `pi/extensions/`
- `pi/prompts/` holds Pi prompt templates for proactive workflows that do not need skill auto-loading.

## Skill portability: avoid "claude-isms"

Claude skills in this repository should be written in a way that is free of "claude-isms" (that is, patterns, tools, or assumptions that only work in Claude). They should be usable as-is from both Claude and Pi via the symlinks described above.

In the rare case where a task genuinely requires a completely different approach that cannot be shared between Claude and Pi, a Pi-specific skill may be added directly under `pi/skills/` rather than as a symlink to a Claude plugin skill. If the workflow is only invoked proactively and does not need skill auto-loading, prefer a prompt template under `pi/prompts/`; the `pi-update` prompt is an example.
