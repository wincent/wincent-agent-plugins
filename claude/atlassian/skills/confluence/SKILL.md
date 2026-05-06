---
description: >-
  Access Confluence data via the Atlassian CLI (`acli`). Use when the user asks about Confluence pages, spaces, blog posts, or otherwise needs to interact with Confluence.
allowed-tools:
  - Bash
---

# Accessing Confluence data

Prefer the Atlassian CLI tool (`acli`) for interacting with Confluence. For anything `acli` does not cover (notably full-text search), fall back to the authenticated `curl` wrapper at `scripts/atlassian-curl.sh`.

## Using `acli`

- `acli confluence --help` shows the available Confluence subcommands (currently `auth`, `blog`, `page`, and `space`).
- For help on a specific subcommand, append `--help`; for example, to view a Confluence page by ID:
  - `acli confluence page view --help`

## Using `scripts/atlassian-curl.sh` (for endpoints `acli` does not expose)

The wrapper takes a URL path plus arbitrary `curl` options and prints the JSON response. Credentials are read from the environment by the script itself; you do **not** need to pass any auth-related arguments, and you do **not** need to read or modify the script. Treat it as an opaque tool.

If the script reports that a required environment variable is unset, surface that to the user and stop — do not try to work around it.

In the examples below, `$SKILL_DIR` is the absolute path to the directory containing the SKILL.md file that defines this skill. Always invoke the wrapper as `$SKILL_DIR/scripts/atlassian-curl.sh` (with `$SKILL_DIR` expanded to its absolute value before running the command); do not invoke it as a bare relative path, since the current working directory is not guaranteed to be the skill directory.

Usage shape:

```sh
$SKILL_DIR/scripts/atlassian-curl.sh <path> [curl options...]
```

Notes:

- `<path>` begins with `/` (e.g. `/wiki/rest/api/search`) and is appended to the configured Atlassian site.
- The script already sets `Accept: application/json`. Do **not** pass `-v` / `--verbose` (it would echo the `Authorization` header to stderr).
- Non-2xx responses cause a non-zero exit, with the JSON error body still printed on stdout.
- The script can also be used for Jira REST endpoints (e.g. `/rest/api/3/...`); prefer `acli jira` first and only fall back to the wrapper for things `acli` lacks.

### Search Confluence (CQL)

The Confluence Cloud search endpoint is `GET /wiki/rest/api/search` and accepts a [CQL](https://developer.atlassian.com/server/confluence/advanced-searching-using-cql/) expression in the `cql` query parameter. Build the CQL from the user's request:

- Free-text match: `text ~ "some phrase"`
- Title match: `title ~ "runbook"`
- Restrict to a space: `space = "ENG"`
- Restrict by content type: `type = page` (or `blogpost`, `attachment`, `space`, `user`)
- Combine with `AND` / `OR`, parentheses, `NOT`.

Use `--data-urlencode` so you do not have to hand-encode the CQL:

```sh
$SKILL_DIR/scripts/atlassian-curl.sh /wiki/rest/api/search \
    --get \
    --data-urlencode 'cql=type = page AND text ~ "incident response"' \
    --data-urlencode 'limit=10'
```

The response is JSON with a `results` array. Each entry has `title`, `excerpt`, `url` (relative — prefix with `https://<site>/wiki` for a clickable link), and a nested `content` object with the page id, type, and space. Pipe through `jq` to summarise, e.g.:

```sh
$SKILL_DIR/scripts/atlassian-curl.sh /wiki/rest/api/search \
    --get \
    --data-urlencode 'cql=space = "ENG" AND type = page AND text ~ "deploy"' \
    --data-urlencode 'limit=10' \
  | jq '.results[] | {title, id: .content.id, excerpt}'
```

For pagination, pass `--data-urlencode 'start=N'`; the response includes `start`, `limit`, `size`, and a `_links.next` field when more results are available.
