---
description: >-
  Access Jira data via the Atlassian CLI (`acli`). Use when the user asks about Jira issues, projects, workitems, sprints, or otherwise needs to interact with Jira.
allowed-tools:
  - Bash
---

# Accessing Jira data

Use the Atlassian CLI tool (`acli`) to interact with Jira. Most everyday operations live under `acli jira workitem`; other groups cover boards, sprints, projects, filters, dashboards, and field metadata.

## Orientation

- `acli jira --help` lists the top-level groups: `auth`, `board`, `dashboard`, `field`, `filter`, `project`, `sprint`, `workitem`.
- For help on any subcommand, append `--help` (e.g. `acli jira workitem search --help`).
- Pass `--json` to any read command for structured output suitable for further processing; the default is a Unicode table optimized for humans.

## View a specific ticket

```sh
acli jira workitem view PROJECT-12345
acli jira workitem view PROJECT-12345 --json
acli jira workitem view PROJECT-12345 --fields '*all'
acli jira workitem view PROJECT-12345 --fields 'summary,description,comment'
```

The default field set is `key,issuetype,summary,status,assignee,description`. Use `*all` for every field, `*navigable` for the navigable subset, or a comma-separated list. Prefix a field with `-` to exclude it (e.g. `*all,-description`).

## Search with JQL

```sh
acli jira workitem search --jql 'project = PROJECT AND resolved >= -7d'
acli jira workitem search --jql 'assignee = currentUser() AND status != Done' --json
acli jira workitem search --jql 'project = PROJECT' --limit 50 --paginate
acli jira workitem search --filter 10001
```

Useful flags on `search`:

- `--jql <query>` — JQL query (see <https://support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jira-query-language-jql/>).
- `--filter <id>` — search using a saved filter ID instead of inline JQL.
- `--fields <list>` — comma-separated list of fields (default `issuetype,key,assignee,priority,status,summary`).
- `--limit <n>` — cap the result count.
- `--paginate` — fetch all matching items across pages.
- `--count` — return only the total count rather than rows.
- `--json` / `--csv` — output formats.
- `--web` — open the search in a browser instead of printing.

## Other workitem operations

`acli jira workitem` also supports `archive`, `assign`, `attachment`, `clone`, `comment`, `create`, `create-bulk`, `delete`, `edit`, `link`, `transition`, `unarchive`, and `watcher`. Run `acli jira workitem <op> --help` for flags and examples.

## Other groups

Use `acli jira <group> --help` to discover subcommands in:

- `board` — Jira boards (Kanban/Scrum).
- `sprint` — sprints under those boards.
- `project` — Jira projects.
- `filter` — saved JQL filters (referenceable from `workitem search --filter <id>`).
- `dashboard` — Jira dashboards.
- `field` — field metadata.
