---
description: Create a commit (or draft a commit message) in a Jujutsu repository
---

# Create a commit (or draft a commit message) in a Jujutsu repository

Your user may invoke this skill explicitly with a slash command, or informally with a phrase like "commit this" or "suggest a commit message". If they use a loose instruction like "commit this" your first task is to determine whether you are working in a Git repository and should make a Git commit (using the dedicated Git commit skill), or you are working in a Jujutsu repo and should create a Jujutsu commit (using this skill).

## Determining the repository type

**IMPORTANT:** Always identify the repository root of the current working directory before making a commit. You must ensure that you are actually in a repo, and that the repo uses the specific version control system that you intend to use to create the commit.

Most frequently, you will be in a Git repository (which you can determine via the presence of a `.git` directory and the absence of a `.jj` directory in the current working directory's repository root). In Git repositories you should use the dedicated Git commit skill to create commits.

Less frequently, you will find yourself in a Jujutsu repository (which you can determine via the presence of a `.jj` directory in the current working directory's repository root). In Jujutsu repositories, you should use this skill to create commits. For general information on Jujutsu, see the Jujutsu version-control skill.

## Creating Jujutsu commits

Generally, if your user wants you to commit only a subset of the changes in the working directory, they will instruct you to do so. Nevertheless, if you determine that there are unrelated changes waiting to be committed, you should clarify with the user how they wish to split them up into distinct commits, rather than committing them all at once.

Jujutsu does not have a concept of a staging area like Git, and running any `jj` command will cause a snapshot of the working directory (including untracked files) to be made; you should therefore interactively prompt your user to indicate which changed files should be included in the change. In the most common case, you can use `jj st` to see which files are in the current snapshot, and `jj show` to see the diff, then `jj split <file>...` to indicate which specific files to be included in the commit (passing your commit message using the `-m` option).

In general, because of the lack of staging area, you should be careful with _any_ `jj` command that creates or modifies a change. For example, if you user asks you to squash some changes into the last commit using `jj squash`, you should prompt the user to indicate _which_ files' changes they want squashed (and invoke `jj squash <file>...` accordingly).

### Passing multi-line commit messages

Most `jj` subcommands (`commit`, `split`, `squash` etc) accept `-m <MESSAGE>` but this is a single shell argument and passing multi-line content through it relies on fragile shell quoting. `jj commit` and `jj split` do **not** support `--stdin` or a `-F/--file` flag (only `jj describe` accepts `--stdin`). Use one of the following recipes instead:

1. **Committing the entire snapshot** (no file filtering): use `jj describe --stdin` followed by `jj new`, which is equivalent to `jj commit`:

   ```bash
   printf '%s' "$MESSAGE" | jj describe --stdin && jj new
   ```

2. **Committing a subset of files, or any command that would open an editor** (`jj commit <files>`, `jj split <files>`, `jj squash --into <rev>` etc): write the message to a temp file and override `JJ_EDITOR` with `cp`, so that jj's "editor" just overwrites its scratch file with your prepared message:

   ```bash
   tmp=$(mktemp)
   cat > "$tmp" <<'EOF'
   feat: subject line

   Body paragraph, wrapped to 72 columns.
   EOF
   JJ_EDITOR="cp $tmp" jj split path/to/file.txt
   rm -f "$tmp"
   ```

   This works because jj invokes the editor as `$JJ_EDITOR <scratch-file>`, so `cp $tmp <scratch-file>` replaces the scratch file's contents with your message before jj reads it back.

## Common instructions

1. Run commands to see what can and should be included in the commit.
2. Note that your user may have asked you to create or update "plan" files under `.agent-notes/`, a directory which may be ignored via the global `~/.config/git/ignore` file: these plan files should never be included in a commit as they are intended to be local-only aids to development.
3. Create a commit message with:
   - A subject of 72 characters or less in Conventional Commits format (eg. "docs: add migration notes" or "fix: avoid double-render in list component"). In repositories that make use of scopes, you can include a scope in parentheses (eg. "chore(frontend): update copyright year" or "feat(login): add support for magic links").
   - A blank line.
   - A detailed description, wrapped to 72 characters, using basic Markdown syntax.
   - At the bottom, include the full text of **all** prompts that were used while preparing the changes that led to the commit; **never** omit any prompts.
   - If you were involved in the preparation of the changes, include a `Co-Authored-By:` trailer identifying the assistant. Derive both fields from your system prompt: use the model name and version as the author name (eg. "Claude Opus 4.7", "GPT-5.5", "Gemini 3.1 Pro") and the provider's standard `noreply` address as the email (eg. `noreply@anthropic.com`, `noreply@openai.com`, `noreply@google.com`). If either is unknown, fall back to `AI Assistant <noreply@example.com>`.

## Best practices

- Subjects MUST start with a Conventional Commits type (eg. "docs", "fix", "feat", "chore" etc; see the table below for a full list) followed by a statement beginning with a verb (eg. "add", "remove", "rename" etc). The subject describes _what_ the commit does.
- The body should explain the motivation for the change, and why the solution was chosen.
- Note alternatives which were considered but not implemented.
- Include references to previous commits or other artifacts (documentation, PRs) that are relevant.

## Conventional Commits types

| Type     | When to use                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------- |
| fix      | Bug fixes                                                                                          |
| feat     | New features                                                                                       |
| chore    | Content                                                                                            |
| refactor | Code improvements (eg. for better readability, easier maintenance etc) which don't change behavior |
| docs     | Documentation changes (including changes to code comments)                                         |
| test     | Changing or adding/removing tests                                                                  |
| perf     | Performance improvements                                                                           |
| style    | Formatting changes, automated lint fixes                                                           |

## Example

```
refactor: remove unused `recurse` setting

We were never exposing a user-accessible setting here. It is always `true`
in practice, except in the benchmarks where we offered an override via the
environment.

If there is ever a call for this in the future, we can resurrect it, but
for now, leaving it out presents us with an opportunity to simplify.
It may even be a tiny bit faster (1.3% better CPU time, and 2.4%
better wall time), with reasonable confidence, due to saving us some
conditional checks.

Agent prompts used in preparing this commit:

> Search the codebase and confirm that the `recurse` setting isn't used
> anywhere outside of the benchmarks, where it is hardcoded to `true`.
> Once you've confirmed that, remove all traces of the setting. Run the
> benchmarks to see they still work, and the tests to see they still pass.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

Substitute your own model identity and vendor `noreply` address per the rule above (eg. `GPT-5.5 <noreply@openai.com>`, `Gemini 3.1 Pro <noreply@google.com>` etc).
