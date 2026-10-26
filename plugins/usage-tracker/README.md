# usage-tracker

Shows your Claude plan usage in a band above the prompt in Claude Code: the 5-hour session window, the weekly all-models window, and any model-scoped weekly limit your plan has (such as Fable), read from the same `limits` list the usage page draws. Each one has a bar, a percentage and a countdown to its reset.

```
╭───────────────────────────────────────────────────────────────────────────────────────────────╮
│  5h ━━━━━━━━━━ 3% resets 3h12m  │ week ━━━━━━━━━━ 28% resets 4d6h  │ Fable ━━━━━━━━━━ 38% resets 4d6h  │
╰───────────────────────────────────────────────────────────────────────────────────────────────╯
```

On narrower terminals the windows stack, one per line, with labels, bars and percentages lined up. The bars shrink to fit, `resets` becomes `↻`, and on very narrow terminals the countdowns are dropped.

## How it stays current

- **One read for every session.** Reads of the usage endpoint (the same one the claude.ai usage page uses, called with the session's own login) are shared through the mod's store, which is a local file. Before reading, a session checks whether another one read recently and uses that result if so. A session that does read takes a 30-second hold first, so other sessions wait for it instead of racing it.
- **Reads less when idle.** A read is due every 2 minutes while any session is active (a prompt or turn in the last 15 minutes), and every 10 minutes otherwise. A turn's end can bring a read forward, but no sooner than 1 minute after the last one.
- **Free figures in between.** Every API response already carries the 5h and weekly percentages, so those bars update after each turn without a read.
- **Fable estimated between reads.** When the weekly figure rises after a turn that ran on Fable, the Fable bar rises by that amount divided by Fable's share of the weekly limit, for example ×2 for a 50% share. Estimated figures show a `~` (`~40%`) until the next real read corrects them.
- The countdowns redraw every 30 seconds.

## Heads-ups

- A toast when any window crosses 80%, 90% or 100%. Each one shows once per reset, across all sessions.
- A yellow line when a window is on pace to run out before it resets, for example `Fable runs out in ~2d3h at this pace (resets in 4d11h)`. It stays quiet for the first tenth of a window, while there's too little data to project from.
- To collapse the band, click `[-]` beside it or press ctrl+x ctrl+a. This is built into Claude Code.

## When a read fails

- A failed read backs off: 1 minute, then 2, 4, 8, and at most 15 minutes. It waits longer if the server's `Retry-After` header asks for more. The first good read resets the backoff.
- The schedule and backoff are shared too, so a 429 holds off every session, and a reload doesn't read again right away.
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
