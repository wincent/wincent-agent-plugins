---
description: >-
  Check for pi updates, review the changelog for breaking changes, assess impact on the user's installed extensions and skills, and advise on the upgrade. Use when the user asks to "update pi", "upgrade pi", "check for pi updates", or "/pi:update".
allowed-tools:
  - bash
  - read
  - grep
  - find
---

# Update pi

Help the user understand what upgrading pi (`@mariozechner/pi-coding-agent`) will entail: what version they are on, what version is available, what breaking changes are in between, and whether any of their locally installed extensions or skills will need adjustment to remain compatible.

**Do not run the upgrade yourself.** Your job is to investigate and advise. Only show the user the command to run.

## Step 1: Determine the current installed version

Try these in order until one yields a version string:

1. `pi --version`
2. `npm list -g --depth=0 @mariozechner/pi-coding-agent 2>/dev/null`
3. Read `package.json` under `$(npm root -g)/@mariozechner/pi-coding-agent/`.

Record this as `CURRENT`.

## Step 2: Determine the latest released version

Run:

```
npm view @mariozechner/pi-coding-agent version
```

Record this as `LATEST`.

If `CURRENT == LATEST`, tell the user they are already up to date and stop (unless they explicitly want to see recent changes anyway).

## Step 3: Fetch the changelog

Fetch the raw changelog via `curl`:

```
curl -sSL https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/CHANGELOG.md
```

(The human-readable URL is <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md>.)

Extract the entries for every version strictly greater than `CURRENT` and less than or equal to `LATEST`. Pay particular attention to:

- Sections or bullets labeled **Breaking**, **BREAKING CHANGE**, **Migration**, **Removed**, or **Deprecated**.
- Changes to extension APIs, event names, `ExtensionContext`/`pi.*` method signatures, tool registration, skill loading, or session format.
- Changes to CLI flags, config file locations, or default behaviors.

Summarize these for the user, grouped by version, with the breaking ones called out first.

## Step 4: Inventory the user's extensions and skills

Enumerate locally installed items that could be affected. Use `ls`, `find`, or `grep` via `bash` as appropriate.

**Extensions** (TypeScript modules):
- `~/.pi/agent/extensions/*.ts`
- `.pi/extensions/*.ts` in the current working directory (and ancestors up to repo root)

**Skills** (`SKILL.md` files and root-level `.md` files):
- `~/.pi/agent/skills/` (direct `.md` files and `*/SKILL.md`)
- `~/.agents/skills/` (`*/SKILL.md` only)
- `.pi/skills/` and `.agents/skills/` in `cwd` and ancestors
- Plugin marketplace skill directories under `~/.claude/plugins/marketplaces/*/` (these often contain pi skills)

For each discovered extension/skill, briefly note its name and purpose (read the file header or frontmatter).

## Step 5: Cross-reference against breaking changes

For every breaking change identified in Step 3, check each extension/skill for usage of the affected API, flag, or convention. Concretely:

- For API renames/removals: `grep` for the old symbol across the extensions directory.
- For event name changes: search for the old event name.
- For config/frontmatter changes: inspect the relevant files directly.

Produce a per-item verdict:

- **Compatible** — no action needed.
- **Needs update** — describe what must change and, where possible, propose the specific edit (file + diff-style snippet).
- **Uncertain** — explain what you could not verify and what the user should double-check manually.

## Step 6: Present findings and the upgrade command

Structure the report as:

1. **Version summary**: `CURRENT` → `LATEST` (and how many versions that spans).
2. **Breaking changes**: bullet list, most impactful first.
3. **Other notable changes**: features, fixes, deprecations.
4. **Impact on your extensions/skills**: the per-item verdicts from Step 5.
5. **Recommended action**:
   - If nothing needs updating, show the upgrade command.
   - If updates are needed, list them and ask the user whether to:
     - Apply the fixes now, **then** show the upgrade command, or
     - Just show the command and let them proceed manually.

The upgrade command is:

```
npm install -g @mariozechner/pi-coding-agent
```

If the user's installation indicates a different package manager (e.g. `pnpm`, `yarn`, `bun`, or a non-global install), adapt the command accordingly and mention how you inferred it.

## Notes

- Never run the install command yourself — always let the user execute it.
- If the changelog cannot be fetched (offline, rate-limited), say so and fall back to `npm view @mariozechner/pi-coding-agent` for whatever release notes are embedded in the package metadata.
- Pre-release/beta versions (`-next`, `-rc`, etc.) should be mentioned but not recommended unless the user asked for them explicitly.
- If `CURRENT` is many versions behind, warn the user that the impact assessment is best-effort and that a staged upgrade (or careful manual review) may be wiser than a single jump.
