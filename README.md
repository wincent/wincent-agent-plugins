# wincent-agent-plugins

Agent[^agent] plugins from Greg Hurrell.

[^agent]: Originally developed for [Claude](https://claude.com/product/claude-code) but usable with other agent(s) such as [Pi](https://pi.dev/) as well. For anything that can't directly consume the plug-ins as is, any agent worth its salt should be able to port them into a suitable format if you point it at this repo and ask it to convert things for you.

## Claude setup

Add the marketplace:

```bash
claude plugin marketplace add wincent/wincent-agent-plugins
```

Then install any plugin:

```bash
claude plugin install atlassian
claude plugin install git
claude plugin install jj
claude plugin install meme
claude plugin install pr
claude plugin install session
claude plugin install shannon
```

## Pi compatibility

The [`pi`](./pi) directory is a compatibility layer for use with [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). It contains symlinks that map each plugin skill to a globally unique name, avoiding collisions that arise because Pi uses a flat skill namespace (whereas Claude Code uses the plugin name as a namespace).

## Plugins

All Claude plugins live under [`claude/`](./claude):

- [atlassian](./claude/atlassian): Jira and Confluence access via the Atlassian CLI (`acli`).
- [git](./claude/git): Git version control skills.
- [jj](./claude/jj): Jujutsu version control skills.
- [meme](./claude/meme): Generate meme images using popular templates via the imgflip API.
- [pr](./claude/pr): GitHub pull request creation and review.
- [session](./claude/session): Claude session management utilities (e.g. export a Claude session to a GitLab snippet).
- [shannon](./claude/shannon): Neovim integration via RPC for annotated code review, walkthroughs, and navigation.
