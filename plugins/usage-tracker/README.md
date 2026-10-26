# usage-tracker

Shows your Claude plan usage in a band above the prompt in Claude Code: the 5-hour session window, the weekly all-models window, and any model-scoped weekly limit your plan has (such as Fable), read from the same `limits` list the usage page draws. Each one has a bar, a percentage and a countdown to its reset.

```
╭───────────────────────────────────────────────────────────────────────────────────────────────╮
│  5h ━━━━━━━━━━ 3% resets 3h12m  │ week ━━━━━━━━━━ 28% resets 4d6h  │ Fable ━━━━━━━━━━ 38% resets 4d6h  │
╰───────────────────────────────────────────────────────────────────────────────────────────────╯
```

On narrower terminals the windows stack, one per line, with labels, bars and percentages lined up. The bars shrink to fit, `resets` becomes `↻`, and on very narrow terminals the countdowns are dropped.

## How it stays current

- Reads the same usage endpoint as the claude.ai usage page, using the session's own login. It reads every 2 minutes, and a turn's end can bring the next read forward to no sooner than 1 minute after the last one.
- Updates the 5-hour and weekly bars right away from the rate-limit figures on each API response, so they stay live between reads.
- Redraws the countdowns every 30 seconds.

## When a read fails

- A failed read backs off: 1 minute, then 2, 4, 8, and at most 15 minutes. It waits longer if the server's `Retry-After` header asks for more. The first good read resets the backoff.
- The schedule is kept in session state, so a reload during a backoff doesn't read again right away.
- The last good figures stay on screen. For the first 5 minutes nothing else changes, so a brief rate limit goes unnoticed. After that a dim line appears under the bars, for example `updated 7m ago · rate-limited · retrying in 3m`. It turns yellow after 20 minutes, or straight away if your login has expired and you need to run `/login`.
- `/usage-refresh` reads straight away, even during a backoff, and says why if the read fails.

This needs a claude.ai subscription login. API-key sessions show `usage: no claude.ai login`.

## Commands

- `/usage-refresh`: read usage now
- `/usage-raw`: show the raw usage response

## Install

```sh
claude plugin marketplace add Wilkins-Software/claude-plugins
claude plugin install usage-tracker@wilkins-software
```
