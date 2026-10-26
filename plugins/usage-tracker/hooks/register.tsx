import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Snapshot, UsageWindow } from '../types'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const POLL_MS = 60_000
const TICK_MS = 30_000
// A turn's end refetches, but no sooner than this after the last read.
const MIN_REFETCH_MS = 15_000
const BAR_WIDTH = 10

const snapshot = atom({ plugin: 'usage-tracker', key: 'snapshot' } as const, null)
const error = atom({ plugin: 'usage-tracker', key: 'error' } as const, null)
const tick = atom({ plugin: 'usage-tracker', key: 'tick' } as const, 0)
const raw = atom({ plugin: 'usage-tracker', key: 'raw' } as const, null)

type ApiWindow = { utilization?: number | null; resets_at?: string | null } | null

// Windows the API reports that aren't a model's own weekly limit.
const SKIPPED = new Set(['seven_day_oauth_apps', 'extra_usage'])

function labelFor(id: string): string {
  if (id === 'five_hour') return '5h'
  if (id === 'seven_day') return 'week'
  const model = id.replace(/^seven_day_/, '')

  return model.charAt(0).toUpperCase() + model.slice(1)
}

function order(id: string): number {
  if (id === 'five_hour') return 0
  if (id === 'seven_day') return 1

  return 2
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)

  return Number.isNaN(ms) ? null : ms
}

export function parseUsage(body: string, fetchedAt: number): Snapshot {
  const json = JSON.parse(body) as Record<string, ApiWindow>
  const windows: UsageWindow[] = []

  for (const [id, value] of Object.entries(json)) {
    const isWindow = id === 'five_hour' || id.startsWith('seven_day')
    if (!isWindow || SKIPPED.has(id) || !value || typeof value.utilization !== 'number') {
      continue
    }
    windows.push({
      id,
      label: labelFor(id),
      percent: value.utilization,
      resetsAt: parseTime(value.resets_at),
    })
  }
  windows.sort((a, b) => order(a.id) - order(b.id) || a.label.localeCompare(b.label))

  return { windows, fetchedAt }
}

// The response headers move between polls; fold their figures in so the band
// keeps up with this session's own turns without waiting for the next read.
export function mergeRateLimits(
  current: Snapshot | null,
  limits: SessionRateLimit[],
  now: number,
): Snapshot | null {
  if (current === null) return null
  const byId = new Map(limits.map(limit => [limit.kind, limit]))
  const windows = current.windows.map(window => {
    const limit = byId.get(window.id)
    if (!limit) return window

    return {
      ...window,
      // Another session's usage only shows in the poll, so never move down
      // until the window has actually reset.
      percent:
        limit.percentUsed >= window.percent || (window.resetsAt ?? Infinity) <= now
          ? limit.percentUsed
          : window.percent,
      resetsAt: parseTime(limit.resetsAt) ?? window.resetsAt,
    }
  })

  return { ...current, windows }
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'now'
  const minutes = Math.ceil(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${String(mins).padStart(2, '0')}m`

  return `${mins}m`
}

function bar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)))

  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

function colorFor(percent: number): 'success' | 'warning' | 'error' {
  if (percent >= 80) return 'error'
  if (percent >= 50) return 'warning'

  return 'success'
}

let lastFetchAt = 0
let isFetching = false

async function refresh($: EngineInterface): Promise<void> {
  if (isFetching) return
  isFetching = true
  try {
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') {
      await update($, error, () => 'no claude.ai login')
      return
    }
    const response = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    })
    const now = await $.clock.now()
    lastFetchAt = now
    if (!response.ok) {
      await update($, error, () => `usage API ${response.status}`)
      return
    }
    await update($, raw, () => response.text)
    await update($, snapshot, () => parseUsage(response.text, now))
    await update($, error, () => null)
  } catch (cause) {
    await update($, error, () => (cause instanceof Error ? cause.message : String(cause)))
  } finally {
    isFetching = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-tracker:raw',
      description: 'Show the raw usage API response behind the usage band',
    })
    await $.command.register({
      name: 'usage-tracker:refresh',
      description: 'Re-read plan usage now',
    })
    void refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    $.clock.every(TICK_MS, () => void update($, tick, n => n + 1))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if ((await $.clock.now()) - lastFetchAt >= MIN_REFETCH_MS) {
      void refresh($)
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      const now = await $.clock.now()
      await update($, snapshot, current => mergeRateLimits(current, e.rateLimits, now))
    }

    return next(e)
  })

  on('command.run', { command: 'usage-tracker:raw' }, async $ => {
    const body = await read($, raw)

    return { text: body ?? 'No usage response yet.' }
  })

  on('command.run', { command: 'usage-tracker:refresh' }, async $ => {
    await refresh($)
    const failure = await read($, error)

    return { text: failure ? `Usage refresh failed: ${failure}` : 'Usage refreshed.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const current = await read($, snapshot)
    const failure = await read($, error)
    await read($, tick)
    const { Box, Text } = $.ui.resolve(e)

    if (current === null) {
      return (
        <Box>
          <Text dimColor>{failure ? `usage: ${failure}` : 'usage: loading…'}</Text>
        </Box>
      )
    }
    const now = await $.clock.now()

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {current.windows.map(window => (
          <Box key={window.id} flexDirection="row" columnGap={1}>
            <Text dimColor>{window.label}</Text>
            <Text color={colorFor(window.percent)}>{bar(window.percent)}</Text>
            <Text color={colorFor(window.percent)}>{`${Math.round(window.percent)}%`}</Text>
            {window.resetsAt !== null && (
              <Text dimColor>{`↻ ${formatRemaining(window.resetsAt - now)}`}</Text>
            )}
          </Box>
        ))}
        {failure && <Text color="warning">{`(stale: ${failure})`}</Text>}
      </Box>
    )
  })
}
