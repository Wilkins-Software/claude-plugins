import { expect, test } from 'claude-code/testing'

import { BODY } from '../tests/fixtures'
import { applyRateLimits, crossings, formatRemaining, paceWarning, parseUsage } from './usage'

const HOUR = 3_600_000
const DAY = 24 * HOUR

test('reads the limits the usage page shows, with Fable and its weekly share', async () => {
  const { windows } = parseUsage(BODY, 0)
  expect(windows.map(w => w.label)).toEqual(['5h', 'week', 'Fable'])
  expect(windows[2]).toMatchObject({ percent: 38, kind: 'scoped', model: 'fable', weeklyShare: 0.5 })
})

test('falls back to the plan-wide windows without limits', async () => {
  const body = JSON.stringify({ five_hour: { utilization: 5, resets_at: null }, seven_day: null })
  expect(parseUsage(body, 0).windows.map(w => w.label)).toEqual(['5h'])
})

test('header figures only raise a window until it resets', async () => {
  const snap = parseUsage(BODY, 0)
  const lower = applyRateLimits(snap, [{ kind: 'seven_day', percentUsed: 10 }], null, 0)
  expect(lower?.windows[1]?.percent).toBe(28)
  const higher = applyRateLimits(snap, [{ kind: 'seven_day', percentUsed: 30 }], null, 0)
  expect(higher?.windows[1]?.percent).toBe(30)
})

test('a weekly rise on a Fable turn moves Fable by twice as much, as an estimate', async () => {
  const snap = parseUsage(BODY, 0)
  const rise = [{ kind: 'seven_day', percentUsed: 29 }]
  const fable = applyRateLimits(snap, rise, 'claude-fable-5-1', 0)
  expect(fable?.windows[2]).toMatchObject({ percent: 40, isEstimate: true })
  const other = applyRateLimits(snap, rise, 'claude-sonnet-5-5', 0)
  expect(other?.windows[2]).toMatchObject({ percent: 38, isEstimate: false })
})

test('crossings name the highest threshold per window and reset', async () => {
  const snap = parseUsage(BODY, 0)
  snap.windows[2] = { ...snap.windows[2]!, percent: 91 }
  expect([...crossings(snap).values()]).toEqual([90])
})

test('pace warns only when a window would run out before it resets', async () => {
  const snap = parseUsage(BODY, 0)
  const fable = snap.windows[2]!
  // Two days into the week at 38%: about 3.3 days left at this rate, 5 to go.
  const resetsAt = 5 * DAY
  snap.windows = [{ ...fable, resetsAt }]
  expect(paceWarning(snap, 0)).toMatchObject({ label: 'Fable' })
  // At 20% it lasts.
  snap.windows = [{ ...fable, percent: 20, resetsAt }]
  expect(paceWarning(snap, 0)).toBe(null)
  // Early in the window it stays quiet.
  snap.windows = [{ ...fable, percent: 10, resetsAt: 7 * DAY - HOUR }]
  expect(paceWarning(snap, 0)).toBe(null)
})

test('formats countdowns', async () => {
  expect(formatRemaining(90 * 60_000)).toBe('1h30m')
  expect(formatRemaining(4 * DAY + 3 * HOUR)).toBe('4d3h')
  expect(formatRemaining(-1)).toBe('now')
})
