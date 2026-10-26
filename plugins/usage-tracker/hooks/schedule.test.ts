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
  readShared,
  statusLine,
} from './schedule'

const MIN = 60_000

test('reads every 2 minutes while active, every 10 while idle', async () => {
  const plan = { ...EMPTY_SCHEDULE, lastAt: 0 }
  expect(isDue(plan, 'due', true, ACTIVE_POLL_MS - 1)).toBe(false)
  expect(isDue(plan, 'due', true, ACTIVE_POLL_MS)).toBe(true)
  expect(isDue(plan, 'due', false, ACTIVE_POLL_MS)).toBe(false)
  expect(isDue(plan, 'due', false, IDLE_POLL_MS)).toBe(true)
})

test('a lease or a backoff holds every session back; manual goes anyway', async () => {
  const leased = { ...EMPTY_SCHEDULE, leaseUntil: 30 * MIN }
  expect(isDue(leased, 'due', true, 20 * MIN)).toBe(false)
  const waiting = { ...EMPTY_SCHEDULE, backoffMs: MIN, retryAt: 30 * MIN }
  expect(isDue(waiting, 'turn', true, 20 * MIN)).toBe(false)
  expect(isDue(waiting, 'manual', true, 20 * MIN)).toBe(true)
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
})

test('a brief failure stays quiet; a long one says so', async () => {
  const limited = { kind: 'rate-limited' as const, status: 429, retryAt: 13 * MIN }
  expect(statusLine(limited, 10 * MIN, 12 * MIN)).toBe(null)
  expect(statusLine(limited, 0, 12 * MIN)).toEqual({
    text: 'updated 12m ago · rate-limited · retrying in 1m',
    isWarning: false,
  })
  expect(statusLine(limited, 0, 30 * MIN)?.isWarning).toBe(true)
  const expired = { kind: 'auth' as const, status: 401, retryAt: 0 }
  expect(statusLine(expired, 11 * MIN, 12 * MIN)).toEqual({
    text: 'updated 1m ago · login expired, run /login',
    isWarning: true,
  })
})

test('a store from another version starts over', async () => {
  expect(readShared({ schedule: { nextAt: 5 } })).toEqual(EMPTY_SHARED)
  expect(readShared(undefined)).toEqual(EMPTY_SHARED)
})
