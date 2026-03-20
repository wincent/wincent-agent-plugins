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

## Plugins

- [git](./git): Git version control skills.
- [jj](./jj): Jujutsu version control skills.
- [meme](./meme): Generate meme images using popular templates via the imgflip API.
- [pr](./pr): GitHub pull request creation and review.
- [session](./session): Claude session management utilities (e.g. export a Claude session to a GitLab snippet).
- [shannon](./shannon): Neovim integration via RPC for annotated code review, walkthroughs, and navigation.
