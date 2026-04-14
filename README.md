# wincent-claude-plugins

Claude plugins from Greg Hurrell.

## Setup

Add the marketplace:

```
claude plugin marketplace add wincent/wincent-claude-plugins
```

Then install any plugin:

```
claude plugin install git
claude plugin install jj
claude plugin install meme
claude plugin install pr
claude plugin install session
claude plugin install shannon
```

## Pi compatibility

The [`pi`](./pi) directory is a compatibility layer for use with the [Pi Coding Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). It contains symlinks that map each plugin skill to a globally unique name, avoiding collisions that arise because Pi uses a flat skill namespace (whereas Claude Code uses the plugin name as a namespace).

## Plugins

- [git](./git): Git version control skills.
- [jj](./jj): Jujutsu version control skills.
- [meme](./meme): Generate meme images using popular templates via the imgflip API.
- [pr](./pr): GitHub pull request creation and review.
- [session](./session): Claude session management utilities (e.g. export a Claude session to a GitLab snippet).
- [shannon](./shannon): Neovim integration via RPC for annotated code review, walkthroughs, and navigation.
