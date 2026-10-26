# claude-plugins

Claude Code plugin marketplace named `wilkins-software`. Manifest: `.claude-plugin/marketplace.json`.

- Each plugin lives in `plugins/<name>/` with `.claude-plugin/plugin.json`; every plugin must also have an entry in `marketplace.json` with `source: "./plugins/<name>"`.
- Create new plugins with `scripts/new-plugin.sh <name> "<description>"` (copies `templates/plugin/`, registers it). Remove unused example components afterward.
- Keep `version` in `plugin.json` and the marketplace entry in sync; bump it on every change you want installs to receive.
- Run `claude plugin validate .` (and `claude plugin validate plugins/<name>`) before committing.
- Update the plugin table in `README.md` when adding or removing a plugin.

## Mods (hooks-module plugins)

Some plugins here are mods: a `hooks/hooks.json` naming a TypeScript hooks module (`export const register: Register = on => {...}`), as `usage-tracker` is.

- Test with `claude plugin test plugins/<name>` (`*.test.ts(x)`, kit from `claude-code/testing`), and run `claude plugin validate` too, since it catches engine rules tsc doesn't: `$` may only be passed to top-level functions, and hooks may not shadow `next`.
- Slash command names can't contain `:`.
- `$.state` and `$.store` outlive reloads and versions. Version anything saved and validate it on read instead of trusting old shapes.
- `$.store` is one JSON file per install source (`~/.claude/plugins/store/<name>_<source>-<hash>.json`). Concurrent sessions of the same install do see each other's writes (verified for usage-tracker).
- While iterating in a session, a dev copy lives under `~/.claude/dev-mods/<session>/`. Copy it into `plugins/<name>/` without `.claude-plugin/types/` or `tsconfig.json` (engine-generated). After pushing, run `claude plugin marketplace update wilkins-software && claude plugin update <name>@wilkins-software`, then `/reload-plugins`.
- Panes (`$.ui.open`) dock on the right in fullscreen and share the dock with built-in panes such as `/diff` as tabs. One the mod opens unasked only docks from 144 columns (110 once the person has opened it).
- A Box's `borderStyle` border never takes its `backgroundColor`; draw the frame from characters in Texts that carry the background when the fill must reach the edge (usage-tracker's `framed`). A hand-drawn frame counts on one row per body line, so give each line `height={1}` or truncate it.
- A tool from `$.tool.register` only type-checks in a `tool.call` matcher after the engine has loaded the mod and listed it in `.claude-plugin/types/claude-code-mcp/`.
