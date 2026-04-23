# Agent instructions

## Formatting checks before committing Markdown

Before creating any commit that contains changes to Markdown files, run `bin/check-format` to see whether any files need formatting fixes. If fixes are needed, run `bin/format` to apply them, then include the resulting changes in the commit.

## Directory structure

Most of the top-level directories in this repository are Claude plugins, each of which contains one or more Claude skills. There is also a `pi/skills/` directory at the top level that contains symlinks to those Claude skills.

One motivation for these symlinks is that Claude plugins effectively serve as namespaces (a skill's fully-qualified name is scoped to its plugin), but pi has no namespacing mechanism. The symlinks under `pi/skills/` give each exposed skill a unique, flat name that pi can use.

## Skill portability: avoid "claude-isms"

Claude skills in this repository should be written in a way that is free of "claude-isms" — that is, patterns, tools, or assumptions that only work in Claude. They should be usable as-is from both Claude and pi via the symlinks described above.

In the rare case where a task genuinely requires a completely different approach that cannot be shared between Claude and pi, a pi-specific skill may be added directly under `pi/skills/` (rather than as a symlink to a Claude plugin skill). The `pi-update` skill is an example of such a pi-only skill.
