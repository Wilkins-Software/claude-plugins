# claude-plugins

Claude Code plugin marketplace named `wilkins-software`. Manifest: `.claude-plugin/marketplace.json`.

- Each plugin lives in `plugins/<name>/` with `.claude-plugin/plugin.json`; every plugin must also have an entry in `marketplace.json` with `source: "./plugins/<name>"`.
- Create new plugins with `scripts/new-plugin.sh <name> "<description>"` (copies `templates/plugin/`, registers it). Remove unused example components afterward.
- Keep `version` in `plugin.json` and the marketplace entry in sync; bump it on every change you want installs to receive.
- Run `claude plugin validate .` (and `claude plugin validate plugins/<name>`) before committing.
- Update the plugin table in `README.md` when adding or removing a plugin.
