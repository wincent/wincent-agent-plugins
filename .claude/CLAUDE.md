# Validation

Before committing, run:

- `bin/check-format` — checks formatting via dprint
- `claude plugin validate .` — validates the top-level marketplace manifest
- `claude plugin validate <plugin-name>` — validates an individual plugin manifest

# Adding a new plugin

When adding a new plugin:

1. Create the plugin directory with the standard layout:
   - `<name>/.claude-plugin/plugin.json` — plugin manifest (name, version, description, author)
   - `<name>/skills/<skill-name>/SKILL.md` — skill definitions
   - `<name>/README.md` — plugin-level documentation
2. Register the plugin in `.claude-plugin/marketplace.json` under `plugins` with `name` and `source` (e.g. `"source": "./<name>"`)
3. Add the plugin to the top-level `README.md` plugins list

# Plugin layout

```
<plugin-name>/
  .claude-plugin/
    plugin.json
  skills/
    <skill-name>/
      SKILL.md
      scripts/       (optional, for helper scripts)
  README.md
```

- Skills are auto-discovered under `skills/`; each subdirectory with a `SKILL.md` becomes a skill
- The skill is invoked as `/<plugin-name>:<skill-name>`
- Use `${CLAUDE_PLUGIN_ROOT}` for paths relative to the plugin root
- Use `${CLAUDE_SKILL_DIR}` for paths relative to the skill directory
