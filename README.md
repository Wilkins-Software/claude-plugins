# Wilkins Software Claude Plugins

Mark Wilkins' personal [Claude Code](https://claude.com/claude-code) plugin marketplace.

## Use it

```sh
# Add the marketplace (once)
claude plugin marketplace add Wilkins-Software/claude-plugins

# Install a plugin from it
claude plugin install <plugin>@wilkins-software

# Pull new versions (installs don't follow pushes)
claude plugin marketplace update wilkins-software
claude plugin update <plugin>@wilkins-software   # then /reload-plugins
```

## Plugins

| Plugin | Description |
| ------ | ----------- |
| [usage-tracker](plugins/usage-tracker) | A mod that shows live plan usage above the prompt: 5h session, weekly and per-model (Fable) bars, reset countdowns, pace warnings and threshold toasts. Reads are shared across sessions and rate-limit safe. |

## Layout

```
.claude-plugin/marketplace.json   # marketplace manifest (name: wilkins-software)
plugins/<name>/                   # one directory per plugin
  .claude-plugin/plugin.json      # plugin manifest
  skills/<skill>/SKILL.md         # skills
  commands/*.md                   # slash commands (/<plugin>:<command>)
  agents/*.md                     # subagents
  hooks/hooks.json                # hooks
templates/plugin/                 # scaffold copied by scripts/new-plugin.sh
scripts/new-plugin.sh             # create + register a new plugin
```

## Add a plugin

```sh
scripts/new-plugin.sh usage-tracker "Track Claude Code usage"
# edit plugins/usage-tracker/...
claude plugin validate .
```

Test locally before pushing:

```sh
claude plugin marketplace add ./
claude plugin install usage-tracker@wilkins-software
```

Bump `version` in the plugin's `plugin.json` (and its marketplace entry) when releasing changes so installs pick up the update.
