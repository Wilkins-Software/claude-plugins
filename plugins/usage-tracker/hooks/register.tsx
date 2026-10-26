import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Snapshot, UsageWindow } from '../types'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const POLL_MS = 60_000
const TICK_MS = 30_000
// A turn's end refetches, but no sooner than this after the last read.
const MIN_REFETCH_MS = 15_000
const BAR_WIDTH = 10
// The band's border and its horizontal padding.
const FRAME_COLUMNS = 6
const SEPARATOR = '  │  '

const snapshot = atom({ plugin: 'usage-tracker', key: 'snapshot' } as const, null)
const error = atom({ plugin: 'usage-tracker', key: 'error' } as const, null)
const tick = atom({ plugin: 'usage-tracker', key: 'tick' } as const, 0)
const raw = atom({ plugin: 'usage-tracker', key: 'raw' } as const, null)

type ApiWindow = { utilization?: number | null; resets_at?: string | null } | null

type ApiLimit = {
  kind: string
  percent?: number | null
  resets_at?: string | null
  scope?: {
    model?: { display_name?: string | null } | null
    surface?: { display_name?: string | null } | string | null
  } | null
}

type ApiBody = Record<string, unknown> & { limits?: ApiLimit[] }

// `limits` kinds that match a rate-limit header's window, so header figures
// can be folded into them between reads.
const HEADER_IDS: Record<string, string> = { session: 'five_hour', weekly_all: 'seven_day' }

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)

  return Number.isNaN(ms) ? null : ms
}

function scopeName(limit: ApiLimit): string | null {
  const surface = limit.scope?.surface

  return (
    limit.scope?.model?.display_name ??
    (typeof surface === 'string' ? surface : surface?.display_name) ??
    null
  )
}

function fromLimit(limit: ApiLimit): UsageWindow | null {
  if (typeof limit.percent !== 'number') return null
  const resetsAt = parseTime(limit.resets_at)
  const headerId = HEADER_IDS[limit.kind]
  if (headerId) {
    const label = headerId === 'five_hour' ? '5h' : 'week'

    return { id: headerId, label, percent: limit.percent, resetsAt }
  }
  const name = scopeName(limit)
  if (!name) return null

  return { id: `${limit.kind}:${name}`, label: name, percent: limit.percent, resetsAt }
}

// Older responses had no `limits`: just the plan-wide windows.
function fromLegacy(json: ApiBody): UsageWindow[] {
  const windows: UsageWindow[] = []
  for (const [id, label] of [['five_hour', '5h'], ['seven_day', 'week']] as const) {
    const value = json[id] as ApiWindow | undefined
    if (value && typeof value.utilization === 'number') {
      windows.push({ id, label, percent: value.utilization, resetsAt: parseTime(value.resets_at) })
    }
  }

  return windows
}

export function parseUsage(body: string, fetchedAt: number): Snapshot {
  const json = JSON.parse(body) as ApiBody
  const windows = Array.isArray(json.limits)
    ? json.limits.map(fromLimit).filter((w): w is UsageWindow => w !== null)
    : fromLegacy(json)

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

function bar(percent: number, width: number): { filled: string; empty: string } {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

  return { filled: '━'.repeat(filled), empty: '━'.repeat(width - filled) }
}

export type Layout = {
  /** One line with separators, or one aligned line per window. */
  mode: 'row' | 'stack'
  barWidth: number
  /** Labels are padded to this in a stack so the bars line up. */
  labelWidth: number
  /** `resets ` when there's room, `↻ ` when tight; null drops the countdown. */
  resetsPrefix: string | null
}

function percentText(percent: number): string {
  return `${Math.round(percent)}%`
}

// Picks the roomiest layout that fits `columns`, the band's width.
export function layoutFor(windows: UsageWindow[], resets: (string | null)[], columns: number): Layout {
  const inner = columns - FRAME_COLUMNS
  const resetsWidth = (prefix: string, index: number) => {
    const text = resets[index]

    return text == null ? 0 : 1 + prefix.length + text.length
  }

  const rowWidth = windows.reduce(
    (sum, window, index) =>
      sum +
      (index > 0 ? SEPARATOR.length : 0) +
      window.label.length + 1 + BAR_WIDTH + 1 + percentText(window.percent).length +
      resetsWidth('resets ', index),
    0,
  )
  const labelWidth = Math.max(0, ...windows.map(window => window.label.length))
  if (rowWidth <= inner) {
    return { mode: 'row', barWidth: BAR_WIDTH, labelWidth, resetsPrefix: 'resets ' }
  }

  // Stacked: label, bar, a right-aligned percent, then the countdown.
  const fixed = labelWidth + 1 + 1 + '100%'.length
  for (const [prefix, minBar] of [['resets ', 8], ['↻ ', 4]] as const) {
    const widest = Math.max(0, ...windows.map((_, index) => resetsWidth(prefix, index)))
    const barWidth = Math.min(20, inner - fixed - widest)
    if (barWidth >= minBar) return { mode: 'stack', barWidth, labelWidth, resetsPrefix: prefix }
  }

  return { mode: 'stack', barWidth: Math.max(3, Math.min(20, inner - fixed)), labelWidth, resetsPrefix: null }
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
      name: 'usage-raw',
      description: 'Show the raw usage API response behind the usage band',
    })
    await $.command.register({
      name: 'usage-refresh',
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

  on('command.run', { command: 'usage-raw' }, async $ => {
    const body = await read($, raw)

    return { text: body ?? 'No usage response yet.' }
  })

  on('command.run', { command: 'usage-refresh' }, async $ => {
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

    const frame = {
      borderStyle: 'round',
      borderDimColor: true,
      paddingX: 2,
      marginTop: 1,
    } as const

    if (current === null) {
      return (
        <Box {...frame}>
          <Text dimColor>{failure ? `usage: ${failure}` : 'usage: loading…'}</Text>
        </Box>
      )
    }
    const now = await $.clock.now()
    const resets = current.windows.map(window =>
      window.resetsAt === null ? null : formatRemaining(window.resetsAt - now),
    )
    const layout = layoutFor(current.windows, resets, e.props.bodyColumns)
    const isStack = layout.mode === 'stack'

    return (
      <Box {...frame} flexDirection={isStack ? 'column' : 'row'}>
        {current.windows.map((window, index) => {
          const color = colorFor(window.percent)
          const { filled, empty } = bar(window.percent, layout.barWidth)
          const label = isStack ? window.label.padEnd(layout.labelWidth) : window.label
          const percent = percentText(window.percent)
          const countdown = resets[index]

          return (
            <Box key={window.id} flexDirection="row">
              {!isStack && index > 0 && <Text dimColor>{SEPARATOR}</Text>}
              <Text bold>{`${label} `}</Text>
              <Text color={color}>{filled}</Text>
              <Text dimColor>{`${empty} `}</Text>
              <Text color={color} bold>{isStack ? percent.padStart(4) : percent}</Text>
              {layout.resetsPrefix !== null && countdown != null && (
                <Text dimColor>{` ${layout.resetsPrefix}${countdown}`}</Text>
              )}
            </Box>
          )
        })}
        {failure && <Text color="warning">{`(stale: ${failure})`}</Text>}
      </Box>
    )
  })
}
