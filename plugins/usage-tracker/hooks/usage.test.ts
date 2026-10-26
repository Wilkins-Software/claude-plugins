import { expect, test } from 'claude-code/testing'

import { BODY } from '../tests/fixtures'
import {
  applyRateLimits,
  crossings,
  formatRemaining,
  hasExpired,
  isSnapshot,
  paceWarning,
  parseUsage,
  settle,
} from './usage'

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

test('crossings name the highest threshold per window, ignoring estimates', async () => {
  const snap = parseUsage(BODY, 0)
  snap.windows[2] = { ...snap.windows[2]!, percent: 91 }
  expect([...crossings(snap, 0).values()].map(c => c.level)).toEqual([90])
  snap.windows[2] = { ...snap.windows[2]!, isEstimate: true }
  expect(crossings(snap, 0).size).toBe(0)
})

test('a window past its reset is never announced again', async () => {
  const snap = parseUsage(BODY, 0)
  snap.windows[2] = { ...snap.windows[2]!, percent: 95 }
  expect(crossings(snap, Date.parse('2026-11-01T00:00:00Z')).size).toBe(0)
})

test('a Fable window past its reset takes no estimate', async () => {
  const snap = parseUsage(BODY, 0)
  const afterReset = Date.parse('2026-11-01T00:00:00Z')
  const moved = applyRateLimits(snap, [{ kind: 'seven_day', percentUsed: 5, resetsAt: '2026-11-07T02:00:00Z' }], 'fable', afterReset)
  expect(moved?.windows[2]).toMatchObject({ percent: 38, isEstimate: false })
})

test('a body with no usage fields is not a usage response', async () => {
  expect(() => parseUsage('{"error":"nope"}', 0)).toThrow()
})

test('the same reset from the headers and the endpoint is one crossing', async () => {
  const snap = parseUsage(BODY, 0)
  const fable = { ...snap.windows[2]!, percent: 85 }
  const a = crossings({ ...snap, windows: [{ ...fable, resetsAt: Date.parse('2026-10-31T01:59:59.942Z') }] }, 0)
  const b = crossings({ ...snap, windows: [{ ...fable, resetsAt: Date.parse('2026-10-31T02:00:00Z') }] }, 0)
  expect([...a.keys()]).toEqual([...b.keys()])
})

test('only snapshots of this version are trusted', async () => {
  expect(isSnapshot(parseUsage(BODY, 0))).toBe(true)
  const { version, ...unversioned } = parseUsage(BODY, 0)
  expect(isSnapshot(unversioned)).toBe(false)
  const broken = parseUsage(BODY, 0)
  broken.windows[0] = { ...broken.windows[0]!, percent: NaN }
  expect(isSnapshot(broken)).toBe(false)
})

test('a window past its reset reads as zero until the next read', async () => {
  const snap = parseUsage(BODY, 0)
  const after5h = Date.parse('2026-10-26T18:00:00Z')
  expect(hasExpired(snap, after5h)).toBe(true)
  const settled = settle(snap, after5h)
  expect(settled?.windows[0]).toMatchObject({ percent: 0, resetsAt: null, isEstimate: true })
  expect(settled?.windows[1]?.percent).toBe(28)
  // Read after that reset: not expired again, so no read every minute.
  expect(hasExpired(parseUsage(BODY, after5h), after5h + 60_000)).toBe(false)
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
  // A window with no length never projects (what showed NaN).
  snap.windows = [{ ...fable, periodMs: null, resetsAt }]
  expect(paceWarning(snap, 0)).toBe(null)
})

test('formats countdowns', async () => {
  expect(formatRemaining(90 * 60_000)).toBe('1h30m')
  expect(formatRemaining(4 * DAY + 3 * HOUR)).toBe('4d3h')
  expect(formatRemaining(-1)).toBe('now')
  expect(formatRemaining(NaN)).toBe('?')
})
