# atlassian

Access Atlassian data via the [Atlassian CLI](https://developer.atlassian.com/cloud/acli/) (`acli`).

## Skills

- `/atlassian:jira` — Access Jira issues, projects, and other Jira data via `acli jira`.
- `/atlassian:confluence` — Access Confluence pages, spaces, and other Confluence data via `acli confluence`.

## Setup

Requires `acli` to be installed and authenticated against your Atlassian instance.

### Optional: REST API fallback

Both skills can fall back to a thin `curl` wrapper for endpoints `acli` does not expose (notably Confluence full-text search via CQL, and any Jira REST endpoint not covered by `acli jira`). To enable it, create a plain Atlassian API token at <https://id.atlassian.com/manage-profile/security/api-tokens> and export the following from your shell rc:

```sh
export ATLASSIAN_SITE=acme              # subdomain, or full "acme.atlassian.net"
export ATLASSIAN_EMAIL=you@example.com  # email associated with the token
export ATLASSIAN_API_KEY=…              # the token itself
```

The token is a regular (non-scoped) Atlassian API token, so the same value can be used for any Confluence or Jira REST endpoint. Store it somewhere your shell can read it (keychain helper, `pass`, `.netrc`-style file, …) — never commit it.

The agent never sees these variable values: it only invokes the wrapper script, which reads them from the environment at runtime.
