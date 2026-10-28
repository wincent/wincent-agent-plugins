# wincent-agent-plugins

[Pi](https://pi.dev/) skills, extensions, and prompt templates (for Claude support, see the repo as it existed at commit [`5738a1ed5275e7239`](https://github.com/wincent/wincent-agent-plugins/tree/5738a1ed5275e7239cec4e2b525c140b9893c1e6)).

## Pi setup

Clone the repository into `~/.local/share/agents/wincent-agent-plugins`:

```bash
mkdir -p ~/.local/share/agents
git clone https://github.com/wincent/wincent-agent-plugins.git \
  ~/.local/share/agents/wincent-agent-plugins
```

Merge these resource paths into your `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "~/.local/share/agents/wincent-agent-plugins/pi/extensions"
  ],
  "skills": [
    "~/.local/share/agents/wincent-agent-plugins/pi/skills"
  ],
  "prompts": [
    "~/.local/share/agents/wincent-agent-plugins/pi/prompts"
  ]
}
```

Individual integrations may need additional tools, credentials, or host-side proxy configuration; see their setup documentation below and the [extensions README](./pi/extensions/README.md).

To update:

```bash
git -C ~/.local/share/agents/wincent-agent-plugins pull --ff-only
```

Then run `/reload` or start a new Pi session.

## Skills

Skills live under [`pi/skills`](./pi/skills/). Invoke them explicitly with `/skill:<name>` or ask Pi for a matching task.

- [atlassian-confluence](./pi/skills/atlassian-confluence): Search and read Confluence Cloud through a shared REST wrapper. See [Atlassian setup](./pi/skills/atlassian-confluence/README.md).
- [atlassian-jira](./pi/skills/atlassian-jira): Search and read Jira Cloud using the same Atlassian setup.
- [datadog-mcp](./pi/skills/datadog-mcp): Query Datadog through native MCP.
- [git-commit](./pi/skills/git-commit): Create Git commits or draft commit messages.
- [google-workspace-mcp](./pi/skills/google-workspace-mcp): Access Google Drive, Sheets, Docs, and Slides through native MCP.
- [jj-commit](./pi/skills/jj-commit): Create Jujutsu commits or draft commit messages.
- [jj-version-control](./pi/skills/jj-version-control): Reference for Jujutsu commands and workflows.
- [meme-create](./pi/skills/meme-create): Generate meme images through imgflip. See [setup](./pi/skills/meme-create/README.md).
- [neovim](./pi/skills/neovim): Interact with Neovim through Shannon RPC. See [setup](./pi/skills/neovim/README.md).
- [ocr](./pi/skills/ocr): Extract text from scanned documents and images. Requires the [OCR extension and setup](./pi/extensions/ocr/README.md).
- [pr-create](./pi/skills/pr-create): Create draft GitHub pull requests. Requires an installed and authenticated [GitHub CLI](https://cli.github.com/) (`gh`).
- [pr-review](./pi/skills/pr-review): Review GitHub pull requests using `gh`.
- [slack-mcp](./pi/skills/slack-mcp): Search and interact with Slack through native MCP.
- [subagent](./pi/skills/subagent): Delegate focused tasks to headless Pi agents. Requires the [subagent extension](./pi/extensions/subagent/).

## Extensions

Extensions live under [`pi/extensions`](./pi/extensions/). See the [extensions README](./pi/extensions/README.md) for usage and prerequisites.

- [context-breakdown](./pi/extensions/context-breakdown.ts)
- [datadog-mcp](./pi/extensions/datadog-mcp.ts)
- [edit-answer](./pi/extensions/edit-answer.ts)
- [google-workspace-mcp](./pi/extensions/google-workspace-mcp.ts)
- [jj-guard](./pi/extensions/jj-guard.ts)
- [model-info](./pi/extensions/model-info.ts)
- [ocr](./pi/extensions/ocr)
- [sandbox](./pi/extensions/sandbox.ts)
- [slack-mcp](./pi/extensions/slack-mcp.ts)
- [subagent](./pi/extensions/subagent)
- [total-cost](./pi/extensions/total-cost.ts)

## Prompt templates

Prompt templates live under [`pi/prompts`](./pi/prompts/):

- [`/sweep`](./pi/prompts/sweep.md): Coordinate a campaign of worker subagents, each making a focused change in its own worktree. Requires the [subagent extension](./pi/extensions/subagent/).

## Tests

Run all extension, subagent, and Atlassian tests from the repository root:

```bash
bin/test
```

Pi tests use the managed runtime at `~/n/pi`. Set `PI_REAL_BIN` to a real Pi executable (not a launcher) to override it; invalid overrides fail without fallback.
