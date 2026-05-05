---
description: >-
  Access Confluence data via the Atlassian CLI (`acli`). Use when the user asks about Confluence pages, spaces, blog posts, or otherwise needs to interact with Confluence.
allowed-tools:
  - Bash
---

# Accessing Confluence data

Use the Atlassian CLI tool (`acli`) to interact with Confluence.

- `acli confluence --help` shows the available Confluence subcommands (currently `auth`, `blog`, `page`, and `space`).
- For help on a specific subcommand, append `--help`; for example, to view a Confluence page by ID:
  - `acli confluence page view --help`

Note: `acli confluence` does **not** provide a full-text search command. If a user asks you to "search Confluence" you will not be able to do so via `acli`; tell them so rather than guessing at a non-existent subcommand.
