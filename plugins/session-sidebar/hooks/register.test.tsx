import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__session-sidebar__todo'
const PANE = {
  plugin: 'session-sidebar',
  component: 'Pane',
  requestId: 'session-sidebar',
  surface: 'terminal',
  props: {
    title: 'Session',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Stands in for the engine beneath the mod.
function engine(on: On) {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__session-sidebar__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 50_000, window: 200_000, percent: 25 }, rateLimits: [], cost: { usd: 1.5 } },
  }))
}

test('the model edits the todo list and the pane shows it', async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const added = await $.tool.call({
    tool: TOOL,
    ops: [
      { op: 'add', text: 'Fix the bug', status: 'active' },
      { op: 'add', text: 'Write docs' },
    ],
  } as never)
  expect(added.result).toBe('1. [>] Fix the bug\n2. [ ] Write docs')
  await $.tool.call({ tool: TOOL, ops: [{ op: 'update', id: 1, status: 'done' }] } as never)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: 'Fix the bug' }))?.props).toMatchObject({ strikethrough: true })
  expect((await ui.find({ type: 'Text', text: '1/2' }))?.text).toBe('1/2')
  expect((await ui.find({ type: 'Text', text: 'Opus 5.5' }))?.text).toBe('Opus 5.5')
  expect((await ui.find({ type: 'Text', text: /50k\/200k/ }))?.text).toBe('50k/200k · $1.50 · 3 turns · 0m')
  await ui.unmount()
})

test('a bad batch is refused and changes nothing', async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const refused = await $.tool.call({ tool: TOOL, ops: [{ op: 'add', text: 'a' }, { op: 'remove', id: 9 }] } as never)
  expect(refused.deny).toBe('ops[1]: no item with id 9')
  const read = await $.tool.call({ tool: TOOL, ops: [] } as never)
  expect(read.result).toBe('The todo list is empty.')
})

test('/clear empties the list', async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, ops: [{ op: 'add', text: 'old task' }] } as never)

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)

  const read = await $.tool.call({ tool: TOOL, ops: [] } as never)
  expect(read.result).toBe('The todo list is empty.')
})

test("the user's prompts carry the list; commands and notifications don't", async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('session.compact', (_, e) => ({ messages: e.messages }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, ops: [{ op: 'add', text: 'Fix the bug', status: 'active' }] } as never)

  // The tool's result showed the model the list, so a prompt only reminds.
  const submit = () => $.prompt.submit({ text: 'and the docs', wait: false, origin: { kind: 'composer' } } as never)
  expect((await submit()).context?.at(-1)).toContain('unchanged')
  // Compaction takes it out of the context, so the next prompt carries it once.
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect((await submit()).context?.at(-1)).toContain('1. [>] Fix the bug')
  expect((await submit()).context?.at(-1)).toContain('unchanged')
  const command = await $.prompt.submit({
    text: '/sidebar',
    command: { name: 'sidebar', args: '' },
    wait: false,
    origin: { kind: 'composer' },
  } as never)
  expect(command.context).toBeUndefined()
  const notified = await $.prompt.submit({ text: 'done', wait: false, origin: { kind: 'plugin', plugin: 'x' } } as never)
  expect(notified.context).toBeUndefined()
})
