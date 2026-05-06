---
description: Export the current session as a GitLab snippet or local Markdown file. Use when the user asks to "create a snippet", "share session", "export to GitLab", or "/snippet".
allowed-tools: Bash(command:*), Bash(pbpaste:*), Bash(cat:*), Bash(head:*), Bash(mktemp:*), Bash(${CLAUDE_SKILL_DIR}/scripts/create-gitlab-snippet.sh:*), Write
---

# Create a GitLab snippet from the current session

## Step 1: Obtain session content

Run `command -v pbpaste` to check whether `pbpaste` is available.

**If `pbpaste` is available (macOS):**

Run `pbpaste | head -5` to check whether the clipboard contains a session export. If it does not look like a Claude Code session (should start with a box drawing header or session content), tell the user to run `/export` first and stop.

**If `pbpaste` is not available (e.g. Ubuntu VM):**

Tell the user to run `/export /tmp/session.txt` and wait for them to confirm. Then verify the file exists with `head -5 /tmp/session.txt`.

## Step 2: Choose a title

Read enough of the session content (from clipboard via `pbpaste` or from the exported file via `cat`) to identify the first user prompt (look for the first `>` or `❯` line after the header). Suggest a short, descriptive title based on what the session is about. Use AskUserQuestion to let the user confirm or customize the title. Offer your suggested title as the first option and "Claude Code Session - YYYY-MM-DD HH:MM" (with the current date/time) as the second.

## Step 3: Write a session summary

Read the full session content (from clipboard via `pbpaste` or from the exported file) and write a Markdown summary of the session. The summary should include:

- A `## Summary` heading
- A brief description of what the session accomplished
- Key topics discussed, decisions made, and actions taken
- Notable outcomes (files changed, commands run, problems solved)

Create a temp file with `mktemp` and write the summary to it using the Write tool.

## Step 4: Create the snippet

Run the snippet creation script, passing the chosen title and the summary file via the `SUMMARY_FILE` environment variable.

**If using clipboard:**

```bash
pbpaste | SUMMARY_FILE="/path/from/mktemp" ${CLAUDE_SKILL_DIR}/scripts/create-gitlab-snippet.sh - "TITLE"
```

**If using exported file:**

```bash
SUMMARY_FILE="/path/from/mktemp" ${CLAUDE_SKILL_DIR}/scripts/create-gitlab-snippet.sh /tmp/session.txt "TITLE"
```

The script uploads to GitLab when `GITLAB_HOST` and `GITLAB_TOKEN` are set; otherwise it writes a local Markdown file.

## Step 5: Report the result

The script prints either a GitLab snippet URL or a local file path. Show whichever is returned to the user.
