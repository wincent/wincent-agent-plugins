# shannon

Neovim integration via RPC for annotated code review, walkthroughs, and navigation.

## Skills

- `/shannon:neovim` — Interact with Neovim via RPC to annotate code, navigate files, and do walkthroughs.

## Setup

Requires a Neovim instance with the [Shannon plugin](https://github.com/wincent/wincent) running in a sibling tmux pane, or a Shannon prompt that includes the Neovim server address.

## Files

- `skills/neovim/SKILL.md` — Skill definition with RPC primitives and usage guidelines.
- `skills/neovim/scripts/shannon-find-nvim.sh` — Discovers the Neovim server socket in a sibling tmux pane.
