import type { SessionRateLimit } from 'claude-code'

import type { Snapshot, UsageWindow } from '../types'

const HOUR_MS = 3_600_000
const SESSION_MS = 5 * HOUR_MS
const WEEK_MS = 7 * 24 * HOUR_MS
// Toasts fire once per window and reset as usage crosses each of these.
export const THRESHOLDS = [80, 90, 100] as const
// Pace stays quiet early in a window, when a projection is mostly noise.
const MIN_ELAPSED_FRACTION = 0.1
// Bump when Snapshot or UsageWindow change: state and the shared store outlive
// the code that wrote them, and a figure of an older shape is dropped, not trusted.
export const SNAPSHOT_VERSION = 2

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

type ApiShare = { limit_index?: number; allowance_percent_of_weekly?: number | null }

type ApiBody = Record<string, unknown> & {
  limits?: ApiLimit[]
  weekly_scoped_shares?: ApiShare[]
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)

  return Number.isNaN(ms) ? null : ms
}

function base(id: string, label: string, kind: UsageWindow['kind'], percent: number, resetsAt: number | null): UsageWindow {
  return {
    id,
    kind,
    label,
    percent,
    resetsAt,
    periodMs: kind === 'session' ? SESSION_MS : WEEK_MS,
    weeklyShare: null,
    model: null,
    isEstimate: false,
  }
}

function fromLimit(limit: ApiLimit, share: number | null): UsageWindow | null {
  if (typeof limit.percent !== 'number') return null
  const resetsAt = parseTime(limit.resets_at)
  if (limit.kind === 'session') return base('five_hour', '5h', 'session', limit.percent, resetsAt)
  if (limit.kind === 'weekly_all') return base('seven_day', 'week', 'weekly', limit.percent, resetsAt)
  const surface = limit.scope?.surface
  const model = limit.scope?.model?.display_name ?? null
  const name = model ?? (typeof surface === 'string' ? surface : surface?.display_name) ?? null
  if (!name) return null

  return {
    ...base(`${limit.kind}:${name}`, name, 'scoped', limit.percent, resetsAt),
    weeklyShare: share,
    model: model?.toLowerCase() ?? null,
  }
}

// Older responses had no `limits`: just the plan-wide windows.
function fromLegacy(json: ApiBody): UsageWindow[] {
  const windows: UsageWindow[] = []
  for (const [id, label, kind] of [
    ['five_hour', '5h', 'session'],
    ['seven_day', 'week', 'weekly'],
  ] as const) {
    const value = json[id] as ApiWindow | undefined
    if (value && typeof value.utilization === 'number') {
      windows.push(base(id, label, kind, value.utilization, parseTime(value.resets_at)))
    }
  }

  return windows
}

export function parseUsage(body: string, fetchedAt: number): Snapshot {
  const json = JSON.parse(body) as ApiBody
  // A body with none of the fields this reads isn't a usage response.
  if (!Array.isArray(json.limits) && !('five_hour' in json) && !('seven_day' in json)) {
    throw new Error('no usage figures in the response')
  }
  if (!Array.isArray(json.limits)) return { version: SNAPSHOT_VERSION, windows: fromLegacy(json), fetchedAt }
  const shares = new Map<number, number>()
  for (const share of json.weekly_scoped_shares ?? []) {
    const allowance = share.allowance_percent_of_weekly
    if (typeof share.limit_index === 'number' && typeof allowance === 'number' && allowance > 0) {
      shares.set(share.limit_index, allowance / 100)
    }
  }
  const windows = json.limits
    .map((limit, index) => fromLimit(limit, shares.get(index) ?? null))
    .filter((window): window is UsageWindow => window !== null)

  return { version: SNAPSHOT_VERSION, windows, fetchedAt }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A snapshot this code wrote, with every field it reads; anything else is dropped. */
export function isSnapshot(value: unknown): value is Snapshot {
  if (!isRecord(value) || value.version !== SNAPSHOT_VERSION || !Array.isArray(value.windows)) return false
  if (!Number.isFinite(value.fetchedAt)) return false

  return value.windows.every(
    window =>
      isRecord(window) &&
      typeof window.id === 'string' &&
      typeof window.label === 'string' &&
      Number.isFinite(window.percent) &&
      (window.resetsAt === null || Number.isFinite(window.resetsAt)) &&
      (window.periodMs === null || Number.isFinite(window.periodMs)),
  )
}

/**
 * True once a window has reset since the read: its figures are spent. A reset
 * already past when read doesn't count, or a stale one would read every minute.
 */
export function hasExpired(snapshot: Snapshot | null, now: number): boolean {
  if (snapshot === null) return false

  return snapshot.windows.some(
    window => window.resetsAt !== null && window.resetsAt > snapshot.fetchedAt && window.resetsAt <= now,
  )
}

// A window past its reset is at zero until the next read says otherwise;
// the next window starts with the first use after it.
export function settle(snapshot: Snapshot | null, now: number): Snapshot | null {
  const isSpent = snapshot?.windows.some(window => window.resetsAt !== null && window.resetsAt <= now)
  if (snapshot === null || !isSpent) return snapshot

  return {
    ...snapshot,
    windows: snapshot.windows.map(window =>
      window.resetsAt !== null && window.resetsAt <= now
        ? { ...window, percent: 0, resetsAt: null, isEstimate: true }
        : window,
    ),
  }
}

// The response headers carry 5h and week with every API response: fold them in
// so those bars keep up with this session's turns between reads. When week
// rises on a turn whose model has a scoped window (Fable), that window rises by
// the same amount over its share of the weekly limit, marked as an estimate
// until the next read.
export function applyRateLimits(
  current: Snapshot | null,
  limits: SessionRateLimit[],
  model: string | null,
  now: number,
): Snapshot | null {
  if (current === null) return null
  const byId = new Map(limits.map(limit => [limit.kind, limit]))
  let weeklyRise = 0
  const windows = current.windows.map(window => {
    const limit = byId.get(window.id)
    if (!limit) return window
    const hasReset = (window.resetsAt ?? Infinity) <= now
    // Another session's usage only shows in a read, so never move down
    // until the window has actually reset.
    if (limit.percentUsed < window.percent && !hasReset) return window
    if (window.id === 'seven_day' && !hasReset) weeklyRise = limit.percentUsed - window.percent

    return {
      ...window,
      percent: limit.percentUsed,
      resetsAt: parseTime(limit.resetsAt) ?? window.resetsAt,
    }
  })
  const name = model?.toLowerCase() ?? ''
  const estimated = windows.map(window => {
    // A scoped window past its own reset holds last week's figure: leave it
    // for the next read rather than add to it.
    const isCurrent = window.resetsAt === null || window.resetsAt > now
    const isCounted =
      weeklyRise > 0 &&
      isCurrent &&
      window.weeklyShare !== null &&
      window.model !== null &&
      name.includes(window.model)
    if (!isCounted) return window

    return {
      ...window,
      percent: Math.min(100, Math.round((window.percent + weeklyRise / (window.weeklyShare ?? 1)) * 10) / 10),
      isEstimate: true,
    }
  })

  return { ...current, windows: estimated }
}

/**
 * The highest threshold each window has reached, keyed so a reset starts
 * over. Estimates don't count: an overshoot shouldn't raise an alarm. The
 * reset is rounded to the hour, as the headers and the endpoint give the same
 * reset a few hundred milliseconds apart.
 */
export function crossings(snapshot: Snapshot | null, now: number): Map<string, { level: number; window: UsageWindow }> {
  const reached = new Map<string, { level: number; window: UsageWindow }>()
  for (const window of snapshot?.windows ?? []) {
    // A window past its reset is spent: announcing it again would repeat.
    if (window.isEstimate || window.resetsAt === null || window.resetsAt <= now) continue
    const level = THRESHOLDS.filter(threshold => window.percent >= threshold).at(-1)
    if (level !== undefined) reached.set(`${window.id}@${Math.round(window.resetsAt / 3_600_000)}`, { level, window })
  }

  return reached
}

/** The hour a crossing key's window resets in, so old keys can be dropped. */
export function crossingHour(key: string): number {
  return Number(key.slice(key.lastIndexOf('@') + 1))
}

export type Pace = { label: string; runsOutIn: number; resetsIn: number }

// The window that will run out soonest at its current rate, if any will run
// out before it resets.
export function paceWarning(snapshot: Snapshot | null, now: number): Pace | null {
  let worst: Pace | null = null
  for (const window of snapshot?.windows ?? []) {
    if (window.resetsAt === null || window.periodMs === null || window.percent >= 100) continue
    const resetsIn = window.resetsAt - now
    const elapsed = window.periodMs - resetsIn
    if (elapsed < window.periodMs * MIN_ELAPSED_FRACTION || window.percent <= 0) continue
    const runsOutIn = ((100 - window.percent) / window.percent) * elapsed
    if (!Number.isFinite(runsOutIn) || runsOutIn >= resetsIn) continue
    if (worst === null || runsOutIn < worst.runsOutIn) {
      worst = { label: window.label, runsOutIn, resetsIn }
    }
  }

  return worst
}

export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms)) return '?'
  if (ms <= 0) return 'now'
  const minutes = Math.ceil(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${String(mins).padStart(2, '0')}m`

  return `${mins}m`
}
