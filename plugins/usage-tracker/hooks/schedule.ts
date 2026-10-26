import type { Attempt, Failure, FailureKind, Schedule, Shared, Snapshot } from '../types'

import { formatRemaining, isSnapshot } from './usage'

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
// A Retry-After past this is taken as a server mistake, not an instruction.
const MAX_RETRY_AFTER_MS = 6 * 3_600_000
// Figures older than this turn the status line from dim to a warning.
const WARN_STALE_MS = 20 * 60_000
// How many reads the history strip keeps.
export const HISTORY_SIZE = 10

export const EMPTY_SCHEDULE: Schedule = { lastAt: 0, backoffMs: 0, retryAt: 0, leaseUntil: 0 }
export const EMPTY_SHARED: Shared = {
  snapshot: null,
  failure: null,
  schedule: EMPTY_SCHEDULE,
  raw: null,
  history: [],
}

export type Reason = 'due' | 'turn' | 'manual'

export type Due = {
  reason: Reason
  isActive: boolean
  /** A window's reset has passed, so the figures on screen are spent. */
  hasExpired: boolean
}

/** Whether this session should read now, given what every session shares. */
export function isDue(schedule: Schedule, due: Due, now: number): boolean {
  if (due.reason === 'manual') return true
  if (now < schedule.leaseUntil || now < schedule.retryAt) return false
  // A backoff that has run out retries at once, not at the next poll.
  if (schedule.backoffMs > 0) return due.reason === 'due'
  const since = now - schedule.lastAt
  if (due.reason === 'turn' || due.hasExpired) return since >= MIN_REFETCH_MS

  return since >= (due.isActive ? ACTIVE_POLL_MS : IDLE_POLL_MS)
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
// when it asks for longer, up to six hours.
export function backoff(previous: Schedule, retryAfterMs: number | null, now: number): Schedule {
  const doubled = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, previous.backoffMs * 2))
  const wait = Math.max(doubled, Math.min(MAX_RETRY_AFTER_MS, retryAfterMs ?? 0))

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

/** What one read of the endpoint came to. */
export type Outcome =
  | { ok: true; at: number; status: number; snapshot: Snapshot; raw: string }
  | { ok: false; at: number; status: number | null; kind: FailureKind; retryAfterMs: number | null }

/**
 * The shared record after a read, merged into what the store holds now
 * (`latest`, read again after the fetch) rather than what it held before: a
 * success another session wrote meanwhile is kept, and the newest figures win.
 */
export function settleShared(latest: Shared, outcome: Outcome, startedAt: number): Shared {
  const history = recordAttempt(latest.history, {
    at: outcome.at,
    status: outcome.status,
    outcome: outcome.ok ? 'ok' : outcome.kind,
  })
  if (outcome.ok) {
    const isNewest = latest.snapshot === null || outcome.snapshot.fetchedAt >= latest.snapshot.fetchedAt

    return {
      snapshot: isNewest ? outcome.snapshot : latest.snapshot,
      raw: isNewest ? outcome.raw : latest.raw,
      failure: null,
      schedule: { lastAt: outcome.at, backoffMs: 0, retryAt: 0, leaseUntil: 0 },
      history,
    }
  }
  const isOvertaken = latest.failure === null && latest.schedule.lastAt > startedAt
  if (isOvertaken) return { ...latest, history }
  const schedule = backoff(latest.schedule, outcome.retryAfterMs, outcome.at)

  return {
    ...latest,
    schedule,
    failure: { kind: outcome.kind, status: outcome.status, retryAt: schedule.retryAt },
    history,
  }
}

export function recordAttempt(history: Attempt[], attempt: Attempt): Attempt[] {
  return [...history, attempt].slice(-HISTORY_SIZE)
}

export function formatAgo(ms: number): string {
  if (!Number.isFinite(ms)) return '?'
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`

  return `${formatRemaining(ms)} ago`
}

export type Health = {
  /** The recent reads, oldest first: true for a good one. */
  blocks: boolean[]
  /** What went wrong, with the HTTP status when there was one. */
  headline: string
  /** When it last tried, when it tries next, how old the figures are. */
  details: string[]
  isWarning: boolean
}

// What the band says while reads are failing; null while they're fine.
export function health(
  failed: Failure | null,
  history: Attempt[],
  fetchedAt: number | null,
  now: number,
): Health | null {
  if (failed === null) return null
  const needsAction = failed.kind === 'auth' || failed.kind === 'no-login'
  const status = failed.status === null ? '' : ` (${failed.status})`
  const last = history.at(-1)
  const details = [
    last ? `tried ${formatAgo(now - last.at)}` : null,
    needsAction ? null : failed.retryAt <= now ? 'retrying now' : `next try in ${formatRemaining(failed.retryAt - now)}`,
    fetchedAt === null ? 'no figures yet' : `figures from ${formatAgo(now - fetchedAt)}`,
  ]

  return {
    blocks: history.map(attempt => attempt.outcome === 'ok'),
    headline: `${FAILURE_TEXT[failed.kind]}${status}`,
    details: details.filter(detail => detail !== null),
    isWarning: needsAction || fetchedAt === null || now - fetchedAt >= WARN_STALE_MS,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A failure this code wrote; an older version's is dropped. */
export function isFailure(value: unknown): value is Failure {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    value.kind in FAILURE_TEXT &&
    (value.status === null || Number.isFinite(value.status)) &&
    Number.isFinite(value.retryAt)
  )
}

function isAttempt(value: unknown): value is Attempt {
  return (
    isRecord(value) &&
    Number.isFinite(value.at) &&
    (value.status === null || Number.isFinite(value.status)) &&
    (value.outcome === 'ok' || (typeof value.outcome === 'string' && value.outcome in FAILURE_TEXT))
  )
}

// The store is a file any version of this mod may have written: take what
// has the right shape and start over on anything else.
export function readShared(value: unknown): Shared {
  if (!isRecord(value) || !isRecord(value.schedule)) return EMPTY_SHARED
  const schedule = value.schedule
  const numbers = ['lastAt', 'backoffMs', 'retryAt', 'leaseUntil'] as const
  if (!numbers.every(key => Number.isFinite(schedule[key]))) return EMPTY_SHARED
  const failure = value.failure

  return {
    snapshot: isSnapshot(value.snapshot) ? value.snapshot : null,
    failure: isFailure(failure) ? failure : null,
    schedule: schedule as Schedule,
    raw: typeof value.raw === 'string' ? value.raw : null,
    history: Array.isArray(value.history) ? value.history.filter(isAttempt).slice(-HISTORY_SIZE) : [],
  }
}
