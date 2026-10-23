# Agent instructions

## Formatting checks before committing

Before creating any commit, run `bin/check-format` to see whether any files need formatting fixes. If fixes are needed, run `bin/format` to apply them, then include the resulting changes in the commit.

## Directory structure

Pi is the supported agent harness. Keep its resources under `pi/`:

- `pi/skills/` holds skill directories with globally unique names, each containing a `SKILL.md` and any supporting scripts, references, or tests.
- `pi/extensions/` holds extensions and their supporting code and tests.
- `pi/prompts/` holds prompt templates for proactive workflows that do not need skill auto-loading.

## Skills

Keep ordinary workflow instructions portable where practical, but use Pi-specific tools and features when the task needs them. Compatibility with other harnesses is not required. Do not add another harness's packaging or compatibility aliases without an explicit need.

Match each skill's frontmatter `name` to its directory name. Resolve bundled script and reference paths relative to the skill directory, not the working directory. If a workflow is only invoked proactively and does not need skill auto-loading, prefer a prompt template under `pi/prompts/`.
