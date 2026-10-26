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

// A store in memory the test can read back (mock.store keeps its own).
function memoryStore(on: On): Map<string, unknown> {
  const entries = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: entries.get(e.key) }))
  on('store.set', (_, e) => {
    entries.set(e.key, e.value)

    return { value: undefined }
  })

  return entries
}

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

test('a failed read backs off, then retries after a minute', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * MIN })
  mock.store(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' as const } }))
  const statuses = [429, 200]
  let count = 0
  on('http.fetch', () => {
    const status = statuses[count++] ?? 200

    return { value: { status, ok: status === 200, headers: {}, text: status === 200 ? BODY : '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(count).toBe(1)
  await clock.advance(30_000)
  expect(count).toBe(1)
  await clock.advance(45_000)
  expect(count).toBe(2)
})

test('figures an older version left in state are dropped, not drawn', async ($, on) => {
  mock.clock(on, { now: 10 * MIN })
  const old = { windows: [{ id: 'five_hour', label: '5h', percent: 30, resetsAt: 20 * MIN }], fetchedAt: 0 }
  on('state.get', (_, e, next) => (e.key === 'snapshot' ? { value: { value: old, version: 1 } } : next(e)))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /NaN/ }))).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /loading/ }))?.text).toBe('usage: loading…')
  await ui.unmount()
})

test('a failing read shows blocks, the status, and when it tries next', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * MIN })
  mock.store(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' as const } }))
  on('http.fetch', () => ({ value: { status: 429, ok: false, headers: { 'retry-after': '120' }, text: '' } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /rate-limited/ }))?.text).toBe(' usage unavailable: rate-limited (429)')
  expect((await ui.find({ type: 'Text', text: /next try/ }))?.text).toBe(' · tried 1s ago · next try in 2m · no figures yet')
  expect((await ui.find({ type: 'Text', text: '■' }))?.text).toBe('■')
  await ui.unmount()
})

test('an API-key session leaves the shared store alone', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * MIN })
  const store = memoryStore(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.authorize', () => ({ value: null }))
  let reads = 0
  on('http.fetch', () => {
    reads += 1

    return { value: { status: 200, ok: true, headers: {}, text: BODY } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(reads).toBe(0)
  expect([...store.keys()]).toEqual([])
})

test('a request that never answers counts as offline after 20 seconds', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * MIN })
  const store = memoryStore(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' as const } }))
  on('http.fetch', () => new Promise(() => {}))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(20_000)
  const shared = store.get('shared') as { failure: { kind: string } | null }
  expect(shared.failure?.kind).toBe('network')
})

test('a band two rows tall shows one line, not an n more', async ($, on) => {
  mock.clock(on)
  on('state.get', (_, e, next) =>
    e.key === 'snapshot' ? { value: { value: parseUsage(BODY, 0), version: 1 } } : next(e),
  )
  const ui = await $.ui.mount({
    ...BAND,
    surface: 'terminal',
    props: { ...BAND.props, maxRows: 2, bodyColumns: 60 },
  })
  expect((await ui.find({ type: 'Text', text: /━/ }))).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /^Fable/ }))?.text).toBe('Fable ')
  await ui.unmount()
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

test('in fullscreen the frame is drawn by hand on the pane background, edge to edge', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * MIN })
  mock.store(on, {
    shared: {
      snapshot: parseUsage(BODY, 9 * MIN),
      failure: null,
      schedule: { lastAt: 9 * MIN, backoffMs: 0, retryAt: 0, leaseUntil: 0 },
      raw: BODY,
    },
  })
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  const ui = await $.ui.mount({
    ...BAND,
    surface: 'terminal',
    viewport: { columns: 120, rows: 40, isFullscreen: true },
  })
  const top = await ui.find({ type: 'Text', text: /^╭/ })
  expect(top?.text.length).toBe(BAND.props.bodyColumns)
  expect(top?.props).toMatchObject({ backgroundColor: '#24252a' })
  // One side cell per body row: the bars stack or not, plus no extra lines here.
  const side = await ui.find({ type: 'Text', text: /^│/ })
  expect(side?.text).toBe('│')
  await ui.unmount()
})
