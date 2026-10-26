import type { Failure, FailureKind, Schedule, Shared } from '../types'

import { formatRemaining } from './usage'

// The response headers keep 5h and week current between reads, and every
// session shares one read, so the endpoint is read every couple of minutes
// while you work and every ten when you don't.
export const ACTIVE_POLL_MS = 2 * 60_000
export const IDLE_POLL_MS = 10 * 60_000
// A session is active this long after its last prompt or turn.
export const ACTIVE_FOR_MS = 15 * 60_000
// A turn's end may bring the next read forward, to no sooner than this after the last.
export const MIN_REFETCH_MS = 60_000
// How long a session holds the read before another may take it over.
export const LEASE_MS = 30_000
const MIN_BACKOFF_MS = 60_000
const MAX_BACKOFF_MS = 15 * 60_000
// A failed read stays quiet while the figures are younger than this.
const QUIET_STALE_MS = 5 * 60_000
// And turns into a warning once they are older than this.
const WARN_STALE_MS = 20 * 60_000

export const EMPTY_SCHEDULE: Schedule = { lastAt: 0, backoffMs: 0, retryAt: 0, leaseUntil: 0 }
export const EMPTY_SHARED: Shared = { snapshot: null, failure: null, schedule: EMPTY_SCHEDULE, raw: null }

export type Reason = 'due' | 'turn' | 'manual'

/** Whether this session should read now, given what every session shares. */
export function isDue(schedule: Schedule, reason: Reason, isActive: boolean, now: number): boolean {
  if (reason === 'manual') return true
  if (now < schedule.leaseUntil || now < schedule.retryAt) return false
  const since = now - schedule.lastAt
  if (reason === 'turn') return schedule.backoffMs === 0 && since >= MIN_REFETCH_MS

  return since >= (isActive ? ACTIVE_POLL_MS : IDLE_POLL_MS)
}

export function classify(status: number | null): FailureKind {
  if (status === null) return 'network'
  if (status === 429) return 'rate-limited'
  if (status === 401 || status === 403) return 'auth'
  if (status >= 500) return 'server'

  return 'bad-response'
}

// Seconds or an HTTP date, as Retry-After allows.
export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(value)

  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

// Doubles from a minute up to fifteen; a Retry-After the server sent wins
// when it asks for longer.
export function backoff(previous: Schedule, retryAfterMs: number | null, now: number): Schedule {
  const doubled = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, previous.backoffMs * 2))
  const wait = Math.min(MAX_BACKOFF_MS, Math.max(doubled, retryAfterMs ?? 0))

  return { lastAt: now, backoffMs: doubled, retryAt: now + wait, leaseUntil: 0 }
}

export const FAILURE_TEXT: Record<FailureKind, string> = {
  'rate-limited': 'rate-limited',
  auth: 'login expired, run /login',
  'no-login': 'needs a claude.ai login',
  server: 'usage service error',
  network: 'offline',
  'bad-response': 'unexpected response',
}

export type Line = { text: string; isWarning: boolean }

// A short line under the bars, or null while a failure isn't worth showing.
export function statusLine(failed: Failure | null, fetchedAt: number | null, now: number): Line | null {
  if (failed === null) return null
  const age = fetchedAt === null ? Infinity : now - fetchedAt
  const needsAction = failed.kind === 'auth' || failed.kind === 'no-login'
  if (!needsAction && age < QUIET_STALE_MS) return null
  const parts = [
    fetchedAt === null ? null : `updated ${formatRemaining(age)} ago`,
    FAILURE_TEXT[failed.kind],
    needsAction ? null : `retrying in ${formatRemaining(failed.retryAt - now)}`,
  ]

  return {
    text: parts.filter(part => part !== null).join(' · '),
    isWarning: needsAction || age >= WARN_STALE_MS,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// The store is a file any version of this mod may have written: take what
// has the right shape and start over on anything else.
export function readShared(value: unknown): Shared {
  if (!isRecord(value) || !isRecord(value.schedule)) return EMPTY_SHARED
  const schedule = value.schedule
  const numbers = ['lastAt', 'backoffMs', 'retryAt', 'leaseUntil'] as const
  if (!numbers.every(key => typeof schedule[key] === 'number')) return EMPTY_SHARED
  const snapshot = isRecord(value.snapshot) && Array.isArray(value.snapshot.windows) ? value.snapshot : null

  return {
    snapshot: snapshot as Shared['snapshot'],
    failure: isRecord(value.failure) ? (value.failure as Failure) : null,
    schedule: schedule as Schedule,
    raw: typeof value.raw === 'string' ? value.raw : null,
  }
}
