import { expect, mock, test } from 'claude-code/testing'

import { formatRemaining, mergeRateLimits, parseUsage } from './register'

const BODY = JSON.stringify({
  five_hour: { utilization: 3, resets_at: '2026-10-26T20:40:00Z' },
  seven_day: { utilization: 28, resets_at: '2026-10-31T05:00:00Z' },
  seven_day_fable: { utilization: 38.4, resets_at: '2026-10-31T05:00:00Z' },
  seven_day_opus: null,
  seven_day_oauth_apps: { utilization: 0, resets_at: null },
  extra_usage: { is_enabled: false },
})

test('parses the windows, model windows after the plan-wide ones', async () => {
  const { windows } = parseUsage(BODY, 0)
  expect(windows.map(w => w.label)).toEqual(['5h', 'week', 'Fable'])
  expect(windows[2]?.percent).toBe(38.4)
})

test('header figures only raise a window until it resets', async () => {
  const snap = parseUsage(BODY, 0)
  const lower = mergeRateLimits(snap, [{ kind: 'seven_day', percentUsed: 10 }], 0)
  expect(lower?.windows[1]?.percent).toBe(28)
  const higher = mergeRateLimits(snap, [{ kind: 'seven_day', percentUsed: 30 }], 0)
  expect(higher?.windows[1]?.percent).toBe(30)
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
    expect((await ui.find({ type: 'Text', text: 'Fable' }))?.text).toBe('Fable')
    expect((await ui.find({ type: 'Text', text: '38%' }))?.text).toBe('38%')
    await ui.unmount()
  }
})
