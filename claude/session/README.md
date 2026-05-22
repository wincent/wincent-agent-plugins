# session

Session management utilities for Claude Code.

## Skills

- `/session:create-gitlab-snippet`: Export the current session as a GitLab snippet.

## Setup

Requires `GITLAB_TOKEN` and `GITLAB_HOST` environment variables. The user must run `/export` first to copy the session to the clipboard.

## Files

- `skills/create-gitlab-snippet/SKILL.md`: Skill definition for creating GitLab snippets.
- `skills/create-gitlab-snippet/scripts/create-gitlab-snippet.sh`: Shell script that calls the GitLab snippets API.
