# meme

Generate meme images using popular templates via the [imgflip](https://imgflip.com/) API.

## Skills

- `/meme:create`: Generate a meme from a template name and caption text.

## Setup

Requires `IMGFLIP_USERNAME` and `IMGFLIP_PASSWORD` environment variables. Create a free account at <https://imgflip.com/signup>.

## Files

- `skills/create/SKILL.md`: Skill definition with template table and generation steps.
- `skills/create/scripts/caption.sh`: Shell script that calls the imgflip caption API.
