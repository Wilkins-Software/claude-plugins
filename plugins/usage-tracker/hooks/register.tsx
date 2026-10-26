import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Failure, Shared, Snapshot } from '../types'
import { FRAME_COLUMNS, SEPARATOR, bar, colorFor, fitHeight, layoutFor, percentText } from './layout'
import type { Fit } from './layout'
import {
  ACTIVE_FOR_MS,
  FAILURE_TEXT,
  LEASE_MS,
  classify,
  health,
  isDue,
  isFailure,
  parseRetryAfter,
  readShared,
  settleShared,
} from './schedule'
import type { Outcome, Reason } from './schedule'
import {
  applyRateLimits,
  crossingHour,
  crossings,
  formatRemaining,
  hasExpired,
  isSnapshot,
  paceWarning,
  parseUsage,
  settle,
} from './usage'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
// How often timers look at the shared store and decide whether to read.
const CHECK_MS = 15_000
const TICK_MS = 30_000
// A read that hasn't answered by now counts as a network failure.
const FETCH_TIMEOUT_MS = 20_000
// The docked pane's ground, read off a screenshot: the engine does not expose it.
const PANE_BACKGROUND = '#24252a'
// Store keys, shared by every session running this mod.
const SHARED_KEY = 'shared'
const NOTIFIED_KEY = 'notified'

const snapshot = atom({ plugin: 'usage-tracker', key: 'snapshot' } as const, null)
const failure = atom({ plugin: 'usage-tracker', key: 'failure' } as const, null)
const tick = atom({ plugin: 'usage-tracker', key: 'tick' } as const, 0)
const raw = atom({ plugin: 'usage-tracker', key: 'raw' } as const, null)
const history = atom({ plugin: 'usage-tracker', key: 'history' } as const, [])

let isFetching = false
let lastActiveAt = 0
// When this session's last main-loop turn ended, for the early read.
let lastTurnAt = 0
let lastTurnModel: string | null = null

// This session's failure, or null when state holds an older version's.
async function readFailure($: EngineInterface): Promise<Failure | null> {
  const value = await read($, failure)

  return isFailure(value) ? value : null
}

// This session's figures, or null when state holds an older version's.
async function readSnapshot($: EngineInterface): Promise<Snapshot | null> {
  const value = await read($, snapshot)

  return isSnapshot(value) ? value : null
}

// Toasts each window once as it crosses 80, 90 and 100%, once across all
// sessions: the levels already announced live in the shared store.
async function announce($: EngineInterface, current: Snapshot | null): Promise<void> {
  const now = await $.clock.now()
  const reached = crossings(current, now)
  if (reached.size === 0) return
  const stored = await $.store.get(NOTIFIED_KEY)
  const notified = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<string, unknown>
  const hourNow = Math.floor(now / 3_600_000)
  // Keep what's announced for windows that haven't reset, so a window that
  // drops out of one read isn't announced again on the next.
  const next: Record<string, number> = {}
  for (const [key, level] of Object.entries(notified)) {
    if (typeof level === 'number' && crossingHour(key) >= hourNow) next[key] = level
  }
  let isChanged = false
  for (const [key, { level, window }] of reached) {
    if (level <= (next[key] ?? 0)) continue
    next[key] = level
    isChanged = true
    const resets = window.resetsAt === null ? '' : ` · resets in ${formatRemaining(window.resetsAt - now)}`
    $.ui.toast(`${window.label} usage at ${percentText(window)}${resets}`, { timeoutMs: 8000 })
  }
  if (isChanged) await $.store.set(NOTIFIED_KEY, next)
}

// Mirrors the shared store into this session's state, taking a newer read
// another session made.
async function adopt($: EngineInterface, shared: Shared): Promise<void> {
  const local = await readSnapshot($)
  if (shared.snapshot && (local === null || shared.snapshot.fetchedAt > local.fetchedAt)) {
    await update($, snapshot, () => shared.snapshot)
    await update($, raw, () => shared.raw)
    await announce($, shared.snapshot)
  }
  const failed = shared.failure
  const attempts = shared.history
  await update($, failure, () => failed)
  await update($, history, () => attempts)
}

type Refreshed = 'read' | 'not-due' | 'busy' | 'no-login'

async function refresh($: EngineInterface, reason: Reason): Promise<Refreshed> {
  // Another session's read is taken even while this one is busy or not due.
  const shared = readShared(await $.store.get(SHARED_KEY))
  await adopt($, shared)
  if (isFetching) return 'busy'
  isFetching = true
  try {
    const now = await $.clock.now()
    const due = {
      reason,
      isActive: now - lastActiveAt < ACTIVE_FOR_MS,
      hasExpired: hasExpired(await readSnapshot($), now),
      lastTurnAt,
    }
    const kind = isDue(shared.schedule, due, now)
    if (kind === null) return 'not-due'
    // No claude.ai login is this session's own business: an API-key session
    // mustn't hold back or back off the sessions that can read.
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') {
      const noLogin: Failure = { kind: 'no-login', status: null, retryAt: 0 }
      await update($, failure, () => noLogin)
      return 'no-login'
    }
    // Hold the read so other sessions wait for this one rather than racing it.
    await $.store.set(SHARED_KEY, { ...shared, schedule: { ...shared.schedule, leaseUntil: now + LEASE_MS } })
    const outcome = await fetchUsage($, auth.handle)
    // Merge into what the store holds now: another session may have read meanwhile.
    const latest = readShared(await $.store.get(SHARED_KEY))
    const settled = settleShared(latest, outcome, now, kind)
    await $.store.set(SHARED_KEY, settled)
    await adopt($, settled)

    return 'read'
  } finally {
    isFetching = false
  }
}

// One read of the endpoint, bounded so a hung request can't stall the session.
async function fetchUsage($: EngineInterface, handle: string): Promise<Outcome> {
  const request = $.http.fetch(USAGE_URL, {
    auth: handle,
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
  })
  const timeout = $.clock.sleep(FETCH_TIMEOUT_MS).then(() => null)
  let response
  try {
    response = await Promise.race([request, timeout])
  } catch {
    response = null
  }
  const at = await $.clock.now()
  if (response === null) return { ok: false, at, status: null, kind: 'network', retryAfterMs: null }
  if (!response.ok) {
    const retryAfterMs = parseRetryAfter(response.headers['retry-after'], at)

    return { ok: false, at, status: response.status, kind: classify(response.status), retryAfterMs }
  }
  try {
    return { ok: true, at, status: response.status, snapshot: parseUsage(response.text, at), raw: response.text }
  } catch {
    return { ok: false, at, status: response.status, kind: 'bad-response', retryAfterMs: null }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A `-p` run or the SDK has no band to draw: it shouldn't read either.
    if (!e.isInteractive) return next(e)
    await $.command.register({
      name: 'usage-raw',
      description: 'Show the raw usage API response behind the usage band',
    })
    await $.command.register({
      name: 'usage-refresh',
      description: 'Re-read plan usage now',
    })
    lastActiveAt = await $.clock.now()
    // Reads only when due, so a reload, or a session started while another
    // read recently, takes the shared figures instead of calling the API.
    void refresh($, 'due')
    $.clock.every(CHECK_MS, () => void refresh($, 'due'))
    $.clock.every(TICK_MS, () => void update($, tick, n => n + 1))

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    lastActiveAt = await $.clock.now()
    // The model this turn will bill, for the scoped-window estimate.
    lastTurnModel = await $.session.model()

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's turn ends inside the main one: it neither marks activity
    // nor names the model the main turn bills.
    if (e.agentId !== undefined) return result
    lastActiveAt = await $.clock.now()
    lastTurnAt = lastActiveAt
    lastTurnModel = e.usage?.model ?? lastTurnModel
    // No read here: the timer reads early once turns have settled (SETTLE_MS).

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      const now = await $.clock.now()
      const model = lastTurnModel ?? (await $.session.model())
      const current = await readSnapshot($)
      const moved = applyRateLimits(current, e.rateLimits, model, now)
      await update($, snapshot, () => moved)
      await announce($, moved)
    }

    return next(e)
  })

  on('command.run', { command: 'usage-raw' }, async $ => {
    const body = await read($, raw)

    return { text: body ?? 'No usage response yet.' }
  })

  on('command.run', { command: 'usage-refresh' }, async $ => {
    const refreshed = await refresh($, 'manual')
    if (refreshed === 'busy') return { text: 'A usage read is already in progress; the band updates when it finishes.' }
    const failed = await readFailure($)
    if (failed === null) return { text: 'Usage refreshed.' }
    if (failed.kind === 'no-login') return { text: `Usage refresh failed: ${FAILURE_TEXT[failed.kind]}.` }
    const now = await $.clock.now()
    const status = failed.status === null ? '' : ` (HTTP ${failed.status})`

    return {
      text: `Usage refresh failed: ${FAILURE_TEXT[failed.kind]}${status}. Next try in ${formatRemaining(failed.retryAt - now)}.`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    await read($, tick)
    const now = await $.clock.now()
    const failed = await readFailure($)
    const attempts = await read($, history)
    const current = settle(await readSnapshot($), now)
    // No subscription, or a plan the endpoint reports no limits for: nothing to show.
    const isEmpty = current !== null && current.windows.length === 0
    if (isEmpty || (current === null && failed?.kind === 'no-login')) return next(e)
    const { Box, Text } = $.ui.resolve(e)

    // The frame gives way first when the band is short of rows.
    // Fullscreen docks panes on a darker ground and the band matches it there. A Box's
    // own border leaves its cells on the terminal's ground, so that frame is drawn by hand.
    const framed = (fit: Fit, rows: number, body: RenderChildren) => {
      if (!e.viewport?.isFullscreen || !fit.hasBorder || e.props.bodyColumns <= FRAME_COLUMNS) {
        return (
          <Box
            borderStyle={fit.hasBorder ? 'round' : undefined}
            borderDimColor
            paddingX={fit.hasBorder ? 2 : 0}
            marginTop={fit.hasMargin ? 1 : 0}
            flexDirection="column"
          >
            {body}
          </Box>
        )
      }
      const edge = (text: string) => (
        <Text dimColor backgroundColor={PANE_BACKGROUND}>
          {text}
        </Text>
      )
      const across = '─'.repeat(Math.max(0, e.props.bodyColumns - 2))
      const side = Array.from({ length: rows }, () => '│').join('\n')

      return (
        <Box flexDirection="column" marginTop={fit.hasMargin ? 1 : 0} backgroundColor={PANE_BACKGROUND}>
          {edge(`╭${across}╮`)}
          <Box flexDirection="row">
            {edge(side)}
            <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingX={2} overflow="hidden">
              {body}
            </Box>
            {edge(side)}
          </Box>
          {edge(`╰${across}╯`)}
        </Box>
      )
    }

    const status = health(failed, attempts, current?.fetchedAt ?? null, now)
    // Recent reads as blocks, then what went wrong and what happens next.
    const statusRow = status && (
      <Box flexDirection="row" height={1} overflow="hidden">
        {status.blocks.map((isOk, index) => (
          <Box key={`attempt-${index}`}>
            <Text color={isOk ? 'success' : 'error'}>■</Text>
          </Box>
        ))}
        <Text color={status.isWarning ? 'warning' : undefined} dimColor={!status.isWarning} bold wrap="truncate-end">
          {`${status.blocks.length > 0 ? ' ' : ''}${current === null ? 'usage unavailable: ' : ''}${status.headline}`}
        </Text>
        <Text dimColor wrap="truncate-end">
          {status.details.length > 0 ? ` · ${status.details.join(' · ')}` : ''}
        </Text>
      </Box>
    )

    if (current === null) {
      return framed(fitHeight(1, 0, e.props.maxRows), 1, statusRow ?? <Text dimColor>usage: loading…</Text>)
    }
    const resets = current.windows.map(window =>
      window.resetsAt === null ? null : formatRemaining(window.resetsAt - now),
    )
    const layout = layoutFor(current.windows, resets, e.props.bodyColumns)
    const isStack = layout.mode === 'stack'
    const pace = paceWarning(current, now)
    const paceRow = pace && (
      <Text color="warning" wrap="truncate-end">
        {`${pace.label} runs out in ~${formatRemaining(pace.runsOutIn)} at this pace (resets in ${formatRemaining(pace.resetsIn)})`}
      </Text>
    )
    // Under the bars; when rows run short the pace line goes before the status.
    const extras = [paceRow, statusRow].filter(Boolean)
    const fit = fitHeight(isStack ? current.windows.length : 1, extras.length, e.props.maxRows)
    const shown = extras.slice(extras.length - fit.extraLines)

    if (fit.isCompact) {
      return framed(
        fit,
        1 + shown.length,
        <Box flexDirection="column">
          <Box flexDirection="row" height={1} overflow="hidden">
            {current.windows.map((window, index) => (
              <Box key={window.id} flexDirection="row" flexShrink={0}>
                {index > 0 && <Text dimColor> · </Text>}
                <Text bold>{`${window.label} `}</Text>
                <Text color={colorFor(window.percent)} bold>{percentText(window)}</Text>
                {resets[index] != null && <Text dimColor>{` ${resets[index]}`}</Text>}
              </Box>
            ))}
          </Box>
          {shown}
        </Box>,
      )
    }

    return framed(
      fit,
      (isStack ? current.windows.length : 1) + shown.length,
      <Box flexDirection="column">
        <Box flexDirection={isStack ? 'column' : 'row'}>
          {current.windows.map((window, index) => {
            const color = colorFor(window.percent)
            const { filled, empty } = bar(window.percent, layout.barWidth)
            const label = isStack ? window.label.padEnd(layout.labelWidth) : window.label
            const percent = percentText(window)
            const countdown = resets[index]

            return (
              <Box key={window.id} flexDirection="row" height={1} overflow="hidden" flexShrink={0}>
                {!isStack && index > 0 && <Text dimColor>{SEPARATOR}</Text>}
                <Text bold>{`${label} `}</Text>
                <Text color={color}>{filled}</Text>
                <Text dimColor>{`${empty} `}</Text>
                <Text color={color} bold>{isStack ? percent.padStart(5) : percent}</Text>
                {layout.resetsPrefix !== null && countdown != null && (
                  <Text dimColor>{` ${layout.resetsPrefix}${countdown}`}</Text>
                )}
              </Box>
            )
          })}
        </Box>
        {shown}
      </Box>,
    )
  })
}
