import { expect, test } from 'claude-code/testing'

import {
  ACTIVE_POLL_MS,
  EMPTY_SCHEDULE,
  EMPTY_SHARED,
  IDLE_POLL_MS,
  backoff,
  classify,
  isDue,
  parseRetryAfter,
  health,
  readShared,
  recordAttempt,
  settleShared,
} from './schedule'
import { parseUsage } from './usage'
import { BODY } from '../tests/fixtures'

const MIN = 60_000

const due = (reason: 'due' | 'manual', options: { isActive?: boolean; hasExpired?: boolean; lastTurnAt?: number } = {}) => ({
  reason,
  isActive: options.isActive ?? true,
  hasExpired: options.hasExpired ?? false,
  lastTurnAt: options.lastTurnAt ?? 0,
})

// A healthy schedule after a regular read at `at`.
const readAt = (at: number) => ({ ...EMPTY_SCHEDULE, lastAt: at, nextAt: at + ACTIVE_POLL_MS })

test('reads in 2-minute slots while active, every 10 minutes while idle', async () => {
  const plan = readAt(0)
  expect(isDue(plan, due('due'), ACTIVE_POLL_MS - 1)).toBe(null)
  expect(isDue(plan, due('due'), ACTIVE_POLL_MS)).toBe('regular')
  expect(isDue(plan, due('due', { isActive: false }), ACTIVE_POLL_MS)).toBe(null)
  expect(isDue(plan, due('due', { isActive: false }), IDLE_POLL_MS)).toBe('regular')
})

test('a lease or a backoff holds every session back; manual goes anyway', async () => {
  const leased = { ...readAt(0), leaseUntil: 30 * MIN }
  expect(isDue(leased, due('due'), 20 * MIN)).toBe(null)
  const waiting = { ...EMPTY_SCHEDULE, backoffMs: MIN, retryAt: 30 * MIN }
  expect(isDue(waiting, due('due'), 20 * MIN)).toBe(null)
  expect(isDue(waiting, due('manual'), 20 * MIN)).toBe('regular')
})

test('a spent backoff retries at once, not at the next slot', async () => {
  const plan = backoff(EMPTY_SCHEDULE, null, 0)
  expect(isDue(plan, due('due'), MIN - 1)).toBe(null)
  expect(isDue(plan, due('due'), MIN)).toBe('regular')
})

test('a window past its reset reads a minute after the last read', async () => {
  const plan = readAt(0)
  expect(isDue(plan, due('due', { isActive: false, hasExpired: true }), MIN)).toBe('regular')
  expect(isDue(plan, due('due', { isActive: false }), MIN)).toBe(null)
})

test('a turn reads early only once turns have settled for 30 seconds', async () => {
  // Read at 0; next slot at 4m (so early reads are worth it until 3m).
  const plan = { ...readAt(0), nextAt: 4 * MIN }
  expect(isDue(plan, due('due', { lastTurnAt: 70_000 }), 90_000)).toBe(null)
  expect(isDue(plan, due('due', { lastTurnAt: 70_000 }), 100_000)).toBe('early')
  // A turn from before the last read doesn't count.
  expect(isDue({ ...plan, lastAt: 80_000 }, due('due', { lastTurnAt: 70_000 }), 150_000)).toBe(null)
  // Not with the next slot under a minute away: that slot is near enough.
  expect(isDue(readAt(0), due('due', { lastTurnAt: 70_000 }), 100_000)).toBe(null)
})

test('an early read takes the next slot, so reads never beat the regular rate', async () => {
  const plan = readAt(0)
  const early = settleShared(
    { ...EMPTY_SHARED, schedule: plan },
    { ok: true, at: 70_000, status: 200, snapshot: parseUsage(BODY, 70_000), raw: BODY },
    70_000,
    'early',
  )
  expect(early.schedule.nextAt).toBe(2 * ACTIVE_POLL_MS)
})

test('a message every 40 seconds for an hour reads no more than once per slot', async () => {
  // Simulate one session: the 15-second timer, turns ending every 40s.
  let plan = readAt(0)
  let reads = 1
  let lastTurnAt = 0
  for (let now = 0; now <= 60 * MIN; now += 15_000) {
    if (now % 40_000 < 15_000) lastTurnAt = now
    const kind = isDue(plan, due('due', { lastTurnAt }), now)
    if (kind === null) continue
    reads += 1
    plan = settleShared(
      { ...EMPTY_SHARED, schedule: plan },
      { ok: true, at: now, status: 200, snapshot: parseUsage(BODY, now), raw: BODY },
      now,
      kind,
    ).schedule
  }
  expect(reads).toBeLessThanOrEqual(1 + 60 * MIN / ACTIVE_POLL_MS)
})

test('classifies failures', async () => {
  expect(classify(429)).toBe('rate-limited')
  expect(classify(401)).toBe('auth')
  expect(classify(503)).toBe('server')
  expect(classify(null)).toBe('network')
  expect(classify(404)).toBe('bad-response')
})

test('reads Retry-After as seconds or a date', async () => {
  expect(parseRetryAfter('120', 0)).toBe(120_000)
  expect(parseRetryAfter(new Date(90_000).toUTCString(), 0)).toBe(90_000)
  expect(parseRetryAfter(undefined, 0)).toBe(null)
})

test('backs off from a minute, doubling to fifteen, honouring Retry-After', async () => {
  let plan = EMPTY_SCHEDULE
  const waits: number[] = []
  for (let i = 0; i < 6; i++) {
    plan = backoff(plan, null, 0)
    waits.push(plan.retryAt / MIN)
  }
  expect(waits).toEqual([1, 2, 4, 8, 15, 15])
  expect(backoff(EMPTY_SCHEDULE, 5 * MIN, 0).retryAt).toBe(5 * MIN)
  // A server asking for an hour gets its hour, not the 15-minute cap.
  expect(backoff(EMPTY_SCHEDULE, 60 * MIN, 0).retryAt).toBe(60 * MIN)
})

test('the status says what failed, when it tried, when it tries next, and how old the figures are', async () => {
  const limited = { kind: 'rate-limited' as const, status: 429, retryAt: 15 * MIN }
  const attempts = [
    { at: 2 * MIN, status: 200, outcome: 'ok' as const },
    { at: 11 * MIN, status: 429, outcome: 'rate-limited' as const },
  ]
  expect(health(null, attempts, 2 * MIN, 12 * MIN)).toBe(null)
  expect(health(limited, attempts, 2 * MIN, 12 * MIN)).toEqual({
    blocks: [true, false],
    headline: 'rate-limited (429)',
    details: ['tried 1m ago', 'next try in 3m', 'figures from 10m ago'],
    isWarning: false,
  })
  expect(health(limited, attempts, null, 12 * MIN)?.details.at(-1)).toBe('no figures yet')
  expect(health(limited, attempts, 0, 30 * MIN)?.isWarning).toBe(true)
  const expired = { kind: 'auth' as const, status: 401, retryAt: 0 }
  expect(health(expired, [], 11 * MIN, 12 * MIN)).toMatchObject({
    headline: 'login expired, run /login (401)',
    details: ['figures from 1m ago'],
    isWarning: true,
  })
})

test('the history keeps the last ten reads', async () => {
  let attempts: ReturnType<typeof recordAttempt> = []
  for (let i = 0; i < 12; i++) attempts = recordAttempt(attempts, { at: i, status: 200, outcome: 'ok' })
  expect(attempts.map(a => a.at)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
})

test('a slow failure never overwrites a success another session wrote meanwhile', async () => {
  const fresh = parseUsage(BODY, 5 * MIN)
  const latest = {
    ...EMPTY_SHARED,
    snapshot: fresh,
    schedule: { ...EMPTY_SCHEDULE, lastAt: 5 * MIN },
  }
  const settled = settleShared(latest, { ok: false, at: 6 * MIN, status: 429, kind: 'rate-limited', retryAfterMs: null }, 4 * MIN, 'regular')
  expect(settled.snapshot).toBe(fresh)
  expect(settled.failure).toBe(null)
  expect(settled.schedule.backoffMs).toBe(0)
  expect(settled.history.map(a => a.outcome)).toEqual(['rate-limited'])
})

test('an older success never replaces newer figures', async () => {
  const newer = parseUsage(BODY, 6 * MIN)
  const latest = { ...EMPTY_SHARED, snapshot: newer }
  const older = parseUsage(BODY, 5 * MIN)
  const settled = settleShared(latest, { ok: true, at: 5 * MIN, status: 200, snapshot: older, raw: BODY }, 4 * MIN, 'regular')
  expect(settled.snapshot).toBe(newer)
})

test('a 0.3.0 schedule without a slot gets one a poll after its last read', async () => {
  const old = { ...EMPTY_SHARED, schedule: { lastAt: 5 * MIN, backoffMs: 0, retryAt: 0, leaseUntil: 0 } }
  expect(readShared(old).schedule.nextAt).toBe(5 * MIN + ACTIVE_POLL_MS)
})

test('a store from another version starts over', async () => {
  expect(readShared({ schedule: { nextAt: 5 } })).toEqual(EMPTY_SHARED)
  expect(readShared(undefined)).toEqual(EMPTY_SHARED)
  // 0.1.x snapshots had no version or periodMs: dropped, the schedule kept.
  const old = { windows: [{ id: 'five_hour', label: '5h', percent: 3, resetsAt: 1 }], fetchedAt: 1 }
  const shared = readShared({ ...EMPTY_SHARED, snapshot: old, failure: { kind: 'nope', retryAt: 1 } })
  expect(shared.snapshot).toBe(null)
  expect(shared.failure).toBe(null)
})
