---
description: >-
  Check for pi updates, review the changelog for breaking changes, assess impact on the user's installed extensions and skills, advise on the upgrade, and (with the user's consent) run the upgrade and apply the local pi-tui hyperlink patch. Use when the user asks to "update pi", "upgrade pi", "check for pi updates", or "/pi:update".
allowed-tools:
  - bash
  - read
  - grep
  - find
---

# Update pi

Help the user understand what upgrading pi (`@mariozechner/pi-coding-agent`) will entail: what version they are on, what version is available, what breaking changes are in between, and whether any of their locally installed extensions or skills will need adjustment to remain compatible. Then offer to run the upgrade for them and, if they accept, apply the local `@mariozechner/pi-tui` hyperlink patch (Step 8) so OSC 8 hyperlinks keep working under tmux.

## Step 1: Determine the current installed version

Try these in order until one yields a version string:

1. `pi --version`
2. `npm list -g --depth=0 @mariozechner/pi-coding-agent 2>/dev/null`
3. Read `package.json` under `$(npm root -g)/@mariozechner/pi-coding-agent/`.

Record this as `CURRENT`.

## Step 2: Determine the latest released version and detect any install cooldown

Run:

```
npm view @mariozechner/pi-coding-agent version
```

Record this as `LATEST` (the absolute latest published version).

This user has npm's `min-release-age` set to **7 days**. Treat this as a hard-coded fact and set `COOLDOWN = 7 days`. Do **not** try to detect it at runtime:

- `npm config get min-release-age` currently returns `null` (npm bug) and `npm config list` also fails to surface it.
- Do **not** read `~/.npmrc` — it contains auth tokens that must not leak into session context.

Now compute the version that a plain `npm install -g @mariozechner/pi-coding-agent` would actually install today. Fetch publish timestamps:

```
npm view @mariozechner/pi-coding-agent time --json
```

This returns a JSON object mapping version strings to ISO publish times (plus bookkeeping keys `created` and `modified` that you should ignore). Let `CUTOFF = now - 7 days`. Set `COOLDOWN_LATEST` to the highest semver version whose publish time is less than or equal to `CUTOFF`. Stable versions should win over pre-releases unless the user explicitly asked for pre-releases.

Classify the situation using `CURRENT`, `COOLDOWN_LATEST`, and `LATEST`:

1. **Up to date**: `CURRENT == LATEST`. Tell the user and stop (unless they explicitly want to see recent changes anyway).
2. **No cooldown, or cooldown already cleared**: `COOLDOWN_LATEST == LATEST`. Single-block report (Step 6 → Scenario A).
3. **Cooldown blocks part of the upgrade**: `CURRENT <= COOLDOWN_LATEST < LATEST`. Two-block report (Step 6 → Scenario B).
4. **Silent downgrade hazard**: `COOLDOWN_LATEST < CURRENT`. A plain `npm install -g @mariozechner/pi-coding-agent` will **downgrade** the user from `CURRENT` to `COOLDOWN_LATEST`, because npm resolves to “the newest version the cooldown allows” without comparing against what is already installed. Two-block report with a prominent warning in Block 1 (Step 6 → Scenario C). This is a real footgun: the installed package’s runtime dependencies can shrink on downgrade, which can break existing extensions that relied on newer transitive deps (e.g. an extension importing `typebox` 1.x when the downgraded pi only ships `@sinclair/typebox` 0.34.x).

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

## Step 6: Present findings and offer to run the upgrade

Choose one of the following scenarios based on Step 2’s classification, present the findings, and end with an explicit prompt asking the user which of the available actions to take. Always include a **don't update** option. Do not start any install until the user has chosen.

The options offered depend on the scenario:

- **Scenario A**: two options — (a) cooldown-respecting update (the plain command), or (b) skip.
- **Scenarios B / C**: three options — (a) cooldown-respecting update, (b) cooldown-override update to `LATEST`, or (c) skip. In Scenario C, mark the cooldown-respecting option as a **downgrade** and recommend against it (or, if `COOLDOWN_LATEST < CURRENT`, replace it with a no-op pin to `CURRENT`).

When the user chooses to update, proceed to Step 7. When they decline, stop after acknowledging.

### Scenario A — No cooldown (single block)

Structure the report as:

1. **Version summary**: `CURRENT` → `LATEST` (and how many versions that spans).
2. **Breaking changes**: bullet list, most impactful first.
3. **Other notable changes**: features, fixes, deprecations.
4. **Impact on your extensions/skills**: the per-item verdicts from Step 5.
5. **Recommended action**:
   - If nothing needs updating, offer the upgrade command.
   - If updates are needed, list them and ask the user whether to apply the fixes now **before** running the upgrade, or to proceed without them.

The upgrade command is:

```
npm install -g @mariozechner/pi-coding-agent
```

### Scenarios B and C — Cooldown active (two blocks)

When `min-release-age` is in effect, a plain `npm install -g @mariozechner/pi-coding-agent` will resolve only to versions at least `COOLDOWN` old. Present the findings as **two blocks** so the user can make an informed choice between respecting their cooldown and overriding it for this install.

Open the report with a short **Cooldown notice** stating the configured `min-release-age` value and naming both targets (`COOLDOWN_LATEST` and `LATEST`) with their publish dates. Then:

**Block 1 — Respect the cooldown (`CURRENT` → `COOLDOWN_LATEST`)**

1. Version summary for that span.
2. Breaking changes in the span (or “none”).
3. Other notable changes in the span.
4. Impact on extensions/skills restricted to changes in the span.
5. Command:
   - If `COOLDOWN_LATEST > CURRENT`: `npm install -g @mariozechner/pi-coding-agent`.
   - If `COOLDOWN_LATEST == CURRENT`: say “no-op under the current cooldown” and omit the command.
   - If `COOLDOWN_LATEST < CURRENT` (Scenario C, downgrade hazard): lead with a prominent warning that running the plain command will **downgrade** the user from `CURRENT` to `COOLDOWN_LATEST`, may break already-working extensions whose transitive deps came from the newer pi, and recommend against running it. Either suggest pinning with `npm install -g @mariozechner/pi-coding-agent@<CURRENT>` to stay put, or skipping Block 1 entirely and going straight to Block 2.

**Block 2 — Override the cooldown (`CURRENT` → `LATEST`)**

1. Version summary for that span.
2. Breaking changes in the span (or “none”).
3. Other notable changes in the span.
4. Impact on extensions/skills across the full span. Where a change is already covered in Block 1, note that; focus the block on the additional changes only Block 2 brings in.
5. Command:

   ```
   npm install -g @mariozechner/pi-coding-agent@<LATEST> --min-release-age=0
   ```

   Include the explicit `@<LATEST>` pin so the resolver cannot choose anything older, and use `--min-release-age=0` as a one-shot override that leaves the user’s global cooldown policy intact. `NPM_CONFIG_MIN_RELEASE_AGE=0 npm install -g @mariozechner/pi-coding-agent@latest` is an equivalent alternative and fine to mention.

## Step 7: Run the chosen upgrade command

Only run this step once the user has explicitly chosen one of the update options offered in Step 6. Echo back which option you are about to execute before running anything, so there is no ambiguity.

Use the command corresponding to the user’s choice:

- Cooldown-respecting (Scenarios A and B): `npm install -g @mariozechner/pi-coding-agent`
- Cooldown-override (Scenarios B and C): `npm install -g @mariozechner/pi-coding-agent@<LATEST> --min-release-age=0` (with `<LATEST>` replaced by the literal version string from Step 2).

Run the command via `bash`, capturing both stdout and stderr, and surface the result to the user. If the install fails (non-zero exit, or no `pi` binary on the resulting PATH), report the failure and **skip Step 8** — do not patch a half-installed package. If the install succeeds, continue to Step 8.

## Step 8: Patch `@mariozechner/pi-tui` to re-enable hyperlinks under tmux

pi-tui ships with OSC 8 hyperlinks force-disabled when it detects tmux or screen, which breaks this user's clickable-path workflow inside tmux. Each `npm install -g` of pi-coding-agent reinstalls pi-tui and reverts this, so re-apply the patch after every successful upgrade.

The patch flips a single hard-coded boolean in pi-tui's `dist/terminal-image.js` so that, when pi-tui detects it is running inside tmux or screen, it reports `hyperlinks: true` instead of `hyperlinks: false`. The relevant region of the file looks like this:

```diff
     const inTmuxOrScreen = !!process.env.TMUX || term.startsWith("tmux") || term.startsWith("screen");
     if (inTmuxOrScreen) {
         const trueColor = colorTerm === "truecolor" || colorTerm === "24bit";
-        return { images: null, trueColor, hyperlinks: false };
+        return { images: null, trueColor, hyperlinks: true };
     }
```

What to do:

1. Find pi-tui's install directory. `npm -g ls '@mariozechner/pi-tui' -p` is one way; use whatever you prefer. The file to edit is `dist/terminal-image.js` inside that directory. If you can't locate the package or the file, stop and tell the user why.

2. Make sure you change **only** the `return` statement that lives inside the `if (inTmuxOrScreen) { … }` branch of `detectCapabilities`. There is a second, structurally similar `return { images: null, trueColor, hyperlinks: false };` further down that handles unknown terminals; that one must stay `false`. Pick whatever editing approach gives you confidence you're only touching the tmux/screen branch.

3. Be idempotent: if the tmux/screen branch already returns `hyperlinks: true`, just report “already patched” and move on. If neither the patched nor the unpatched form is present in the expected shape, the upstream code has changed — don't guess; show the user the current `detectCapabilities` body and ask how to proceed.

4. After patching, verify the file: the tmux/screen branch should be `true`, the unknown-terminal fallback should still be `false`, and the file should otherwise be unchanged.

5. Tell the user, in plain prose, that you applied the pi-tui hyperlink patch and where, and remind them it will need re-applying after every future `npm install -g @mariozechner/pi-coding-agent` (which is why this skill does it automatically).

## Notes

- Run the install command (Step 7) only after the user has explicitly chosen an update option in Step 6. Never auto-run an install just because the user invoked the skill.
- If the changelog cannot be fetched (offline, rate-limited), say so and fall back to `npm view @mariozechner/pi-coding-agent` for whatever release notes are embedded in the package metadata.
- Pre-release/beta versions (`-next`, `-rc`, etc.) should be mentioned but not recommended unless the user asked for them explicitly.
- If `CURRENT` is many versions behind, warn the user that the impact assessment is best-effort and that a staged upgrade (or careful manual review) may be wiser than a single jump.
- `min-release-age` (npm 11+) makes `npm install` resolve to “the newest version older than the cooldown,” and npm does **not** protect against downgrades — if every version newer than `CURRENT` is inside the cooldown window, a plain install will silently move the user to a lower version. Always check Step 2’s classification before recommending the plain command.
- The cooldown is hard-coded to 7 days for this user because `npm config get min-release-age` returns `null` (bug) and reading `~/.npmrc` would leak auth tokens. If the user later says their cooldown has changed, update the `COOLDOWN = 7 days` line in Step 2 rather than adding runtime detection.
- When a breaking change landed inside the cooldown window (Scenario B/C), extensions authored against the newer API may work on `LATEST` but not on `COOLDOWN_LATEST` (or vice versa on downgrade). Call this out in the per-block impact analysis.
