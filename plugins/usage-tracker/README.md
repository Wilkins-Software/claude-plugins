# usage-tracker

Shows your Claude plan usage in a band above the prompt in Claude Code: the 5-hour session window, the weekly all-models window, and any model-scoped weekly limit your plan has (such as Fable), read from the same `limits` list the usage page draws. Each one has a bar, a percentage and a countdown to its reset.

```
╭───────────────────────────────────────────────────────────────────────────────────────────────╮
│  5h ━━━━━━━━━━ 3% resets 3h12m  │ week ━━━━━━━━━━ 28% resets 4d6h  │ Fable ━━━━━━━━━━ 38% resets 4d6h  │
╰───────────────────────────────────────────────────────────────────────────────────────────────╯
```

On narrower terminals the windows stack, one per line, with labels, bars and percentages lined up. The bars shrink to fit, `resets` becomes `↻`, and on very narrow terminals the countdowns are dropped.

In short panes, such as a split terminal, the band fits the rows it's given instead of scrolling behind an `n more`. It drops, in order: the blank line above it, the border, the pace and status lines, and finally the bars, leaving one line like `5h 5% 2h26m · week 28% 4d10h · Fable 38% 4d10h`.

## How it stays current

- **One read for every session.** Reads of the usage endpoint (the same one the claude.ai usage page uses, called with the session's own login) are shared through the mod's store, which is a local file. Before reading, a session checks whether another one read recently and uses that result if so. A session that does read takes a 30-second hold first, so other sessions wait for it instead of racing it.
- **Reads in fixed slots.** A read is due every 2 minutes while any session is active (a prompt or turn in the last 15 minutes), and every 10 minutes otherwise. After a turn, once no new turn has ended for 30 seconds, the next read can come early, but only if the next slot is more than a minute away and the last read was at least a minute ago. An early read takes the place of the next slot rather than adding one. So a burst of messages causes a single read at the end, and no amount of messaging pushes reads above one every 2 minutes on average.
- **Free figures in between.** Every API response already carries the 5h and weekly percentages, so those bars update after each turn without a read.
- **Fable estimated between reads.** When the weekly figure rises after a turn that ran on Fable, the Fable bar rises by that amount divided by Fable's share of the weekly limit, for example ×2 for a 50% share. Estimated figures show a `~` (`~40%`) until the next real read corrects them.
- The countdowns redraw every 30 seconds.

## Heads-ups

- A toast when any window crosses 80%, 90% or 100%. Each one shows once per reset, across all sessions.
- A yellow line when a window is on pace to run out before it resets, for example `Fable runs out in ~2d3h at this pace (resets in 4d11h)`. It stays quiet for the first tenth of a window, while there's too little data to project from.
- To collapse the band, click `[-]` beside it or press ctrl+x ctrl+a. This is built into Claude Code.

## When a read fails

While reads are failing, a status row shows up. It sits under the bars, or on its own if there are no figures yet:

```
■■■■■■■■■■ rate-limited (429) · tried 40s ago · next try in 3m · figures from 7m ago
```

- **The blocks:** one per recent read by any session, oldest first. Up to 10 are kept. Green means a good read, red a failed one.
- **The status:** what went wrong, with the HTTP status when there was one: rate-limited, login expired, usage service error, offline, or unexpected response.
- **The details:** when the last read was, when the next one is due, and how old the figures on screen are.
- **Colour:** the row is dim while the figures are recent. It turns yellow once they're over 20 minutes old, or if there are no figures at all, or straight away if your login has expired and you need to run `/login`.

How it recovers:

- A failed read backs off: 1 minute, then 2, 4, 8, and at most 15 minutes. If the server's `Retry-After` header asks for longer, the mod waits that long, up to 6 hours. When the backoff runs out, it retries at once. The first good read resets everything.
- The schedule and backoff are shared too, so a 429 holds off every session. A failed read never overwrites figures another session read successfully in the meantime.
- A read that hasn't answered after 20 seconds counts as offline, so a hung request can't stall a session.
- Sessions without a claude.ai login (API-key sessions) and `-p` or SDK runs never read and never touch the shared store, so they can't block the sessions that can read.
- The last good figures stay on screen. A window past its reset time shows 0% until the next read, which happens about a minute later.
- `/usage-refresh` reads straight away, even during a backoff, and says what happened.

## Commands

- `/usage-refresh`: read usage now
- `/usage-raw`: show the raw usage response

## Install

```sh
claude plugin marketplace add Wilkins-Software/claude-plugins
claude plugin install usage-tracker@wilkins-software
```
