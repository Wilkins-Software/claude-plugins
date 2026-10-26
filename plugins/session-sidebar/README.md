# session-sidebar

A sidebar docked on the right of Claude Code with three small cards: the session's model and context fill, the prompt cache's status, and a todo list of the tasks you've given Claude in this session.

```
╭──────────────────────────────────────────╮
│              Opus 5.5 · high             │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 12%  │
│   116k/1.0M · $2.02 · 4 turns · 14m      │
╰──────────────────────────────────────────╯
╭──────────────────────────────────────────╮
│         ● cache warm · 52m left          │
│        97% cached · 0 cold writes        │
│        rewrite $0.93 · warm $0.02        │
╰──────────────────────────────────────────╯
╭──────────────────────────────────────────╮
│  Todo                               1/3  │
│  ✔ Extend the band background            │
│  ⠹ Bug hunt the sidebar                  │
│  ○ Write the docs and push               │
╰──────────────────────────────────────────╯
```

## Where it shows

- It opens when a session starts. In the fullscreen layout it docks beside the transcript; on the main screen (`CLAUDE_CODE_NO_FLICKER=0`, or tmux by default) it sits inline above the prompt.
- Claude Code only docks a pane the mod opens by itself on a terminal at least 144 columns wide (110 once you've opened it yourself). Below that it waits. `/sidebar` opens it at any width.
- Other panes, such as `/diff`, share the dock as tabs. ctrl+x tab focuses the sidebar, and ctrl+x x or its `×` closes it.

## The cards

**Context**

- The model, cleaned up (`claude-opus-5-5[1m]` reads as `Opus 5.5`), and the effort the last request was sent with. Mods can't read the effort setting itself, so the effort shows after the first reply. A thinking budget shows as, for example, `32k budget`.
- How full the context window is, as a bar that turns yellow at 50% and red at 80%.
- Tokens used out of the window, the session's cost, its turns and how long it has run.

**Cache**

- Whether the prompt cache is warm, counted down from the last request of the main conversation. It goes yellow under 10 minutes and red once cold, and reads `reset by compaction` until the first request after a compact. Subagent requests don't count.
- How much of the last request was served from the cache, and how many cold writes this session has paid for and what they cost. A cold write is a request that read less than half of a previous prompt of 20k tokens or more from the cache.
- What re-writing the current context would cost if the cache went cold, against a warm read.
- The cache lifetime is fixed at one hour, the default for subscription sessions. API-key sessions cache for 5 minutes unless `promptCacheTtl` is set to `"1h"`, and the countdown will be wrong for them.
- Prices are per model family, taken from [cache-tax](https://github.com/karanb192/cache-tax) (MIT). This card only displays: it doesn't keep the cache warm or stop a cold send. Use cache-tax for that.

**Todo**

- Claude keeps the list by itself with the `todo` tool this mod adds: each task you give it goes on the list, the one it's working on is marked active, and finished ones are marked done. Plain questions aren't added.
- It's told how twice: once in the system prompt, and again in a short note attached to each prompt you type, which also carries the current list. The note is what makes it stick, since the model reads it right beside your ask. Slash commands, notifications and other plugins' prompts don't get it.
- Ask Claude to add, remove, reword or reorder "the todo list" and it edits this one. It's separate from Claude's own planning list (TodoWrite).
- The active item has a spinner while Claude is working, and a `▸` between turns. Done items are checked and crossed out. The header counts done items out of all of them.
- The card takes at most a quarter of the sidebar's height. A longer list shows a window that follows the active item, with `↑ n more` and `↓ n more` rows.
- Subagents can't edit the list. `/clear` empties it.

## Commands

- `/sidebar`: open the sidebar, at any terminal width.

## Install

```sh
claude plugin marketplace add Wilkins-Software/claude-plugins
claude plugin install session-sidebar@wilkins-software --scope user
```

## Update

Installs don't follow pushes. To get a new version:

```sh
claude plugin marketplace update wilkins-software
claude plugin update session-sidebar@wilkins-software
```

Then run `/reload-plugins` in each open session, or start a new one.

## Development

- `hooks/register.tsx` handles the wiring: hooks, timers and drawing. The logic lives in pure modules: `hooks/todos.ts` (the tool's operations and the list's window), `hooks/cache.ts` (cold writes, the countdown, prices) and `hooks/format.ts`. `types/index.d.ts` is the state contract.
- Tests: `claude plugin test plugins/session-sidebar`. Validate: `claude plugin validate plugins/session-sidebar`.
- Everything is kept in `$.state`, so it lasts for the session and survives reloads, but not new sessions. Each atom has a `shape` tag; bump it when its type changes, so older values are dropped instead of trusted.
- The tool's matcher in `tsc` only type-checks once the engine has loaded the mod and listed its tool in `.claude-plugin/types/claude-code-mcp/`.
- Adding the tool and its prompt section to a running session changes the prompt, so the next reply misses the cache once.
