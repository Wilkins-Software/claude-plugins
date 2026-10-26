import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseUsage } from './usage'
import { BODY } from '../tests/fixtures'

const MIN = 60_000
const BAND = {
  plugin: 'usage-tracker',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// Stands in for the engine: a login, the usage endpoint (counted), commands.
function engine(on: On) {
  const reads = { count: 0 }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' as const } }))
  on('http.fetch', () => {
    reads.count += 1

    return { value: { status: 200, ok: true, headers: {}, text: BODY } }
  })

  return reads
}

test('a fresh read another session left is used instead of calling the API', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * MIN })
  const shared = {
    snapshot: parseUsage(BODY, 9 * MIN),
    failure: null,
    schedule: { lastAt: 9 * MIN, backoffMs: 0, retryAt: 0, leaseUntil: 0 },
    raw: BODY,
  }
  mock.store(on, { shared })
  const reads = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(reads.count).toBe(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Fable/ }))?.text).toBe('Fable ')
  await ui.unmount()

  // Two minutes after that read, an active session reads once.
  await clock.advance(2 * MIN)
  expect(reads.count).toBe(1)
})

test('draws the band on every surface', async ($, on) => {
  mock.clock(on)
  on('state.get', (_, e, next) =>
    e.key === 'snapshot' ? { value: { value: parseUsage(BODY, 0), version: 1 } } : next(e),
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /38%/ }))?.text).toBe('38%')
    await ui.unmount()
  }
})
