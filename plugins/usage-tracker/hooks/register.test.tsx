import { expect, mock, test } from 'claude-code/testing'

import { formatRemaining, layoutFor, mergeRateLimits, parseUsage } from './register'

const BODY = JSON.stringify({
  five_hour: { utilization: 3, resets_at: '2026-10-26T17:39:59Z' },
  seven_day: { utilization: 28, resets_at: '2026-10-31T01:59:59Z' },
  seven_day_opus: null,
  iguana_necktie: { utilization: 50.9, resets_at: '2026-11-05T07:59:00Z' },
  limits: [
    { kind: 'session', percent: 3, resets_at: '2026-10-26T17:39:59Z', scope: null },
    { kind: 'weekly_all', percent: 28, resets_at: '2026-10-31T01:59:59Z', scope: null },
    {
      kind: 'weekly_scoped',
      percent: 38,
      resets_at: '2026-10-31T01:59:59Z',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    },
  ],
})

test('reads the limits the usage page shows, Fable included', async () => {
  const { windows } = parseUsage(BODY, 0)
  expect(windows.map(w => w.label)).toEqual(['5h', 'week', 'Fable'])
  expect(windows[2]?.percent).toBe(38)
})

test('falls back to the plan-wide windows without limits', async () => {
  const body = JSON.stringify({ five_hour: { utilization: 5, resets_at: null }, seven_day: null })
  expect(parseUsage(body, 0).windows.map(w => w.label)).toEqual(['5h'])
})

test('header figures only raise a window until it resets', async () => {
  const snap = parseUsage(BODY, 0)
  const lower = mergeRateLimits(snap, [{ kind: 'seven_day', percentUsed: 10 }], 0)
  expect(lower?.windows[1]?.percent).toBe(28)
  const higher = mergeRateLimits(snap, [{ kind: 'seven_day', percentUsed: 30 }], 0)
  expect(higher?.windows[1]?.percent).toBe(30)
})

test('one row when it fits, an aligned stack when it does not', async () => {
  const { windows } = parseUsage(BODY, 0)
  const resets = ['3h10m', '4d11h', '4d11h']
  expect(layoutFor(windows, resets, 120).mode).toBe('row')
  const stack = layoutFor(windows, resets, 80)
  expect(stack).toMatchObject({ mode: 'stack', labelWidth: 5, resetsPrefix: 'resets ' })
  expect(stack.barWidth).toBeLessThanOrEqual(20)
  expect(layoutFor(windows, resets, 30).resetsPrefix).toBe('↻ ')
  expect(layoutFor(windows, resets, 20).resetsPrefix).toBe(null)
})

test('formats countdowns', async () => {
  expect(formatRemaining(90 * 60_000)).toBe('1h30m')
  expect(formatRemaining(4 * 86_400_000 + 3 * 3_600_000)).toBe('4d3h')
  expect(formatRemaining(-1)).toBe('now')
})

test('draws the band from a stored snapshot', async ($, on) => {
  mock.clock(on)
  on('state.get', (_, e, next) =>
    e.key === 'snapshot' ? { value: { value: parseUsage(BODY, 0), version: 1 } } : next(e),
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'usage-tracker',
      component: 'AbovePrompt',
      surface,
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 120,
        scroll: { offset: 0, bodyRows: 10 },
        view: {},
      },
    })
    expect((await ui.find({ type: 'Text', text: /^Fable/ }))?.text).toBe('Fable ')
    expect((await ui.find({ type: 'Text', text: /38%/ }))?.text).toBe('38%')
    await ui.unmount()
  }
})
