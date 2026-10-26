# usage-tracker

Shows your Claude plan usage in a band above the prompt in Claude Code: the 5-hour session window, the weekly all-models window, and any per-model weekly limit (such as Fable). Each one has a bar, a percentage and a countdown to its reset.

```
5h ██░░░░░░░░ 18% ↻ 3h12m   week ███░░░░░░░ 28% ↻ 4d6h   Fable ████░░░░░░ 38% ↻ 4d6h
```

## How it stays current

- Reads the same usage endpoint as the claude.ai usage page, using the session's own login. It reads once when the session starts, every 60 seconds after that, and again after each turn (at most once every 15 seconds).
- Updates the 5-hour and weekly bars right away from the rate-limit figures on each API response.
- Redraws the countdowns every 30 seconds.

This needs a claude.ai subscription login. API-key sessions show `usage: no claude.ai login`.

## Commands

- `/usage-tracker:refresh`: read usage now
- `/usage-tracker:raw`: show the raw usage response

## Install

```sh
claude plugin marketplace add Wilkins-Software/claude-plugins
claude plugin install usage-tracker@wilkins-software
```
