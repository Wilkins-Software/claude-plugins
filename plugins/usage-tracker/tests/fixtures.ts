// A usage response shaped like the real one, trimmed to what the mod reads.
export const BODY = JSON.stringify({
  five_hour: { utilization: 3, resets_at: '2026-10-26T17:39:59Z' },
  seven_day: { utilization: 28, resets_at: '2026-10-31T01:59:59Z' },
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
  weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 19, allowance_percent_of_weekly: 50 }],
})

