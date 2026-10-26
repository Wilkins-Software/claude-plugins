import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Shared, Snapshot } from '../types'
import { SEPARATOR, bar, colorFor, layoutFor, percentText } from './layout'
import {
  ACTIVE_FOR_MS,
  FAILURE_TEXT,
  LEASE_MS,
  backoff,
  classify,
  isDue,
  parseRetryAfter,
  readShared,
  statusLine,
} from './schedule'
import type { Reason } from './schedule'
import { applyRateLimits, crossings, formatRemaining, paceWarning, parseUsage } from './usage'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
// How often timers look at the shared store and decide whether to read.
const CHECK_MS = 15_000
const TICK_MS = 30_000
// Store keys, shared by every session running this mod.
const SHARED_KEY = 'shared'
const NOTIFIED_KEY = 'notified'

const snapshot = atom({ plugin: 'usage-tracker', key: 'snapshot' } as const, null)
const failure = atom({ plugin: 'usage-tracker', key: 'failure' } as const, null)
const tick = atom({ plugin: 'usage-tracker', key: 'tick' } as const, 0)
const raw = atom({ plugin: 'usage-tracker', key: 'raw' } as const, null)

let isFetching = false
let lastActiveAt = 0
let lastTurnModel: string | null = null

// Toasts each window once as it crosses 80, 90 and 100%, once across all
// sessions: the levels already announced live in the shared store.
async function announce($: EngineInterface, current: Snapshot | null): Promise<void> {
  const reached = crossings(current)
  if (reached.size === 0) return
  const stored = await $.store.get(NOTIFIED_KEY)
  const notified = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<string, number>
  const next: Record<string, number> = {}
  const now = await $.clock.now()
  let isChanged = false
  for (const [key, level] of reached) {
    const previous = notified[key] ?? 0
    next[key] = Math.max(previous, level)
    if (level <= previous) continue
    isChanged = true
    const window = current?.windows.find(one => key.startsWith(`${one.id}@`))
    if (!window) continue
    const resets = window.resetsAt === null ? '' : ` · resets in ${formatRemaining(window.resetsAt - now)}`
    $.ui.toast(`${window.label} usage at ${percentText(window)}${resets}`, { timeoutMs: 8000 })
  }
  if (isChanged) await $.store.set(NOTIFIED_KEY, next)
}

// Mirrors the shared store into this session's state, taking a newer read
// another session made.
async function adopt($: EngineInterface, shared: Shared): Promise<void> {
  const local = await read($, snapshot)
  if (shared.snapshot && (local === null || shared.snapshot.fetchedAt > local.fetchedAt)) {
    await update($, snapshot, () => shared.snapshot)
    await update($, raw, () => shared.raw)
    await announce($, shared.snapshot)
  }
  const failed = shared.failure
  await update($, failure, () => failed)
}

async function refresh($: EngineInterface, reason: Reason): Promise<void> {
  if (isFetching) return
  isFetching = true
  try {
    const shared = readShared(await $.store.get(SHARED_KEY))
    await adopt($, shared)
    const now = await $.clock.now()
    if (!isDue(shared.schedule, reason, now - lastActiveAt < ACTIVE_FOR_MS, now)) return
    // Hold the read so other sessions wait for this one rather than racing it.
    await $.store.set(SHARED_KEY, { ...shared, schedule: { ...shared.schedule, leaseUntil: now + LEASE_MS } })

    const settled = await fetchUsage($, shared)
    await $.store.set(SHARED_KEY, settled)
    await adopt($, settled)
  } finally {
    isFetching = false
  }
}

// One read of the endpoint, answered as the shared record it leaves.
async function fetchUsage($: EngineInterface, shared: Shared): Promise<Shared> {
  const failed = async (status: number | null, retryAfterMs: number | null, kind = classify(status)) => {
    const at = await $.clock.now()
    const schedule = backoff(shared.schedule, retryAfterMs, at)

    return { ...shared, schedule, failure: { kind, status, retryAt: schedule.retryAt } }
  }
  const auth = await $.session.authorize()
  if (!auth || auth.kind !== 'bearer') return failed(null, null, 'no-login')
  let response
  try {
    response = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    })
  } catch {
    return failed(null, null)
  }
  const at = await $.clock.now()
  if (!response.ok) {
    return failed(response.status, parseRetryAfter(response.headers['retry-after'], at))
  }
  try {
    return {
      snapshot: parseUsage(response.text, at),
      failure: null,
      schedule: { lastAt: at, backoffMs: 0, retryAt: 0, leaseUntil: 0 },
      raw: response.text,
    }
  } catch {
    return failed(response.status, null, 'bad-response')
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
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

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    lastActiveAt = await $.clock.now()
    lastTurnModel = e.usage?.model ?? lastTurnModel
    void refresh($, 'turn')

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      const now = await $.clock.now()
      const model = lastTurnModel ?? (await $.session.model())
      await update($, snapshot, current => applyRateLimits(current, e.rateLimits, model, now))
      await announce($, await read($, snapshot))
    }

    return next(e)
  })

  on('command.run', { command: 'usage-raw' }, async $ => {
    const body = await read($, raw)

    return { text: body ?? 'No usage response yet.' }
  })

  on('command.run', { command: 'usage-refresh' }, async $ => {
    await refresh($, 'manual')
    const failed = await read($, failure)
    if (failed === null) return { text: 'Usage refreshed.' }
    const now = await $.clock.now()
    const status = failed.status === null ? '' : ` (HTTP ${failed.status})`

    return {
      text: `Usage refresh failed: ${FAILURE_TEXT[failed.kind]}${status}. Next try in ${formatRemaining(failed.retryAt - now)}.`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const current = await read($, snapshot)
    const failed = await read($, failure)
    await read($, tick)
    const { Box, Text } = $.ui.resolve(e)

    const frame = {
      borderStyle: 'round',
      borderDimColor: true,
      paddingX: 2,
      marginTop: 1,
    } as const

    const now = await $.clock.now()
    const status = statusLine(failed, current?.fetchedAt ?? null, now)

    if (current === null) {
      return (
        <Box {...frame}>
          <Text color={status?.isWarning ? 'warning' : undefined} dimColor={!status?.isWarning}>
            {failed ? `usage: ${FAILURE_TEXT[failed.kind]}` : 'usage: loading…'}
          </Text>
        </Box>
      )
    }
    const resets = current.windows.map(window =>
      window.resetsAt === null ? null : formatRemaining(window.resetsAt - now),
    )
    const layout = layoutFor(current.windows, resets, e.props.bodyColumns)
    const isStack = layout.mode === 'stack'
    const pace = paceWarning(current, now)

    return (
      <Box {...frame} flexDirection="column">
        <Box flexDirection={isStack ? 'column' : 'row'}>
          {current.windows.map((window, index) => {
            const color = colorFor(window.percent)
            const { filled, empty } = bar(window.percent, layout.barWidth)
            const label = isStack ? window.label.padEnd(layout.labelWidth) : window.label
            const percent = percentText(window)
            const countdown = resets[index]

            return (
              <Box key={window.id} flexDirection="row">
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
        {pace && (
          <Text color="warning">
            {`${pace.label} runs out in ~${formatRemaining(pace.runsOutIn)} at this pace (resets in ${formatRemaining(pace.resetsIn)})`}
          </Text>
        )}
        {status && (
          <Text color={status.isWarning ? 'warning' : undefined} dimColor={!status.isWarning}>
            {status.text}
          </Text>
        )}
      </Box>
    )
  })
}
