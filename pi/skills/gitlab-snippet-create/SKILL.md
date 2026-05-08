---
description: >-
  Export the current pi session as a GitLab snippet or local Markdown file.
  Use when the user asks to "create a snippet", "share session",
  "export to GitLab", or "/snippet".
---

# Create a GitLab snippet from the current pi session

## Step 1: Find the session file

The current session JSONL path can be obtained by running `/session` in pi
or by looking at `~/.pi/agent/sessions/`. If you cannot determine it, ask the
user.

## Step 2: Choose a title

Read the first few entries of the session file to find the first user message.
Suggest a short, descriptive title based on what the session is about. Ask the
user to confirm or customize the title. Offer your suggestion and
"Pi Session - YYYY-MM-DD HH:MM" (with the current date/time) as alternatives.

## Step 3: Write a session summary

Read the session file to understand what the session accomplished. Write a
brief Markdown summary (a few sentences to a short paragraph) covering:

- What the session accomplished
- Key decisions made and actions taken
- Notable outcomes (files changed, problems solved)

Write the summary to a temp file using `mktemp`.

## Step 4: Convert and upload (or save locally)

Pipe the conversion output to the upload script, passing the summary file
as the second argument to the conversion script. Below, `$SKILL_DIR` is the
absolute path to the directory containing this SKILL.md file; expand it to
its absolute value before running, since the current working directory is
not guaranteed to be the skill directory.

```bash
$SKILL_DIR/scripts/jsonl-to-markdown.sh "<session.jsonl>" "/path/to/summary" \
  | $SKILL_DIR/scripts/create-gitlab-snippet.sh - "TITLE"
```

The script automatically detects whether `GITLAB_HOST` and `GITLAB_TOKEN` are
set. If they are, it uploads to GitLab and prints the snippet URL. If not, it
writes a local Markdown file and prints the path.

## Step 5: Report the result

The script prints either a GitLab snippet URL or a local file path. Show
the output to the user. If a local file was written, suggest next steps
(e.g. copy-paste into a GitLab snippet or attach to an issue).
