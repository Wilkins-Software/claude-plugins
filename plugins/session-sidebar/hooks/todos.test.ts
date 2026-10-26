import { expect, test } from 'claude-code/testing'

import type { Todo, Todos } from '../types'
import { EMPTY_TODOS, apply, describe, reminder, windowTodos } from './todos'

function list(...statuses: Todo['status'][]): Todo[] {
  return statuses.map((status, index) => ({ id: index + 1, text: `task ${index + 1}`, status }))
}

function applied(start: Todos, ops: unknown): Todos {
  const result = apply(start, ops)
  if (typeof result === 'string') throw new Error(result)

  return result
}

test('adds, updates, reorders and removes in order', async () => {
  let todos = applied(EMPTY_TODOS, [
    { op: 'add', text: '  write   docs ' },
    { op: 'add', text: 'fix bug', before: 1 },
  ])
  expect(todos.items.map(item => item.text)).toEqual(['fix bug', 'write docs'])
  expect(todos.nextId).toBe(3)

  todos = applied(todos, [
    { op: 'update', id: 1, text: 'write the docs', before: 2 },
    { op: 'remove', id: 2 },
  ])
  expect(todos.items).toEqual([{ id: 1, text: 'write the docs', status: 'pending' }])
})

test('one item is active at a time', async () => {
  let todos = applied(EMPTY_TODOS, [
    { op: 'add', text: 'a', status: 'active' },
    { op: 'add', text: 'b' },
  ])
  todos = applied(todos, [{ op: 'update', id: 2, status: 'active' }])
  expect(todos.items.map(item => item.status)).toEqual(['pending', 'active'])
  todos = applied(todos, [{ op: 'add', text: 'c', status: 'active' }])
  expect(todos.items.map(item => item.status)).toEqual(['pending', 'pending', 'active'])
})

test('a bad op rejects the whole batch with a reason', async () => {
  const start = applied(EMPTY_TODOS, [{ op: 'add', text: 'a' }])
  expect(apply(start, 'nope')).toBe('ops must be a list')
  expect(apply(start, [null])).toBe('ops[0]: must be an object')
  expect(apply(start, [{ op: 'add', text: 'b' }, { op: 'remove', id: '1' }])).toBe('ops[1]: no item with id "1"')
  expect(apply(start, [{ op: 'add', text: ' ' }])).toBe('ops[0]: add needs text')
  expect(apply(start, [{ op: 'update', id: 1, status: 'started' }])).toBe(
    'ops[0]: status must be pending, active or done',
  )
  expect(apply(start, [{ op: 'explode' }])).toBe('ops[0]: op must be add, update, remove, clear_done or clear_all')
})

test('clears done items or everything', async () => {
  const start: Todos = { nextId: 4, items: list('done', 'pending', 'done') }
  expect(applied(start, [{ op: 'clear_done' }]).items.map(item => item.id)).toEqual([2])
  expect(applied(start, [{ op: 'clear_all' }])).toEqual({ nextId: 4, items: [] })
})

test('describes the list for the model', async () => {
  expect(describe(EMPTY_TODOS)).toBe('The todo list is empty.')
  expect(describe({ nextId: 3, items: list('done', 'active') })).toBe('1. [x] task 1\n2. [>] task 2')
})

test('the window keeps the active item in view', async () => {
  const items = list('done', 'active', 'done', 'done', 'done', 'done', 'done', 'pending')
  const view = windowTodos(items, 4)
  expect(view.shown.map(item => item.id)).toContain(2)
  expect(view.above + view.shown.length + view.below).toBe(items.length)
  // The markers and the items never take more than the room.
  expect((view.above > 0 ? 1 : 0) + view.shown.length + (view.below > 0 ? 1 : 0)).toBeLessThanOrEqual(4)
})

test('the window never outgrows its room', async () => {
  const items = list(...Array.from({ length: 12 }, () => 'pending' as const))
  for (let room = -2; room <= 14; room++) {
    for (let active = 0; active < items.length; active++) {
      const withActive = items.map((item, index) => (index === active ? { ...item, status: 'active' as const } : item))
      const view = windowTodos(withActive, room)
      const rows = (view.above > 0 ? 1 : 0) + view.shown.length + (view.below > 0 ? 1 : 0)
      expect(rows).toBeLessThanOrEqual(Math.max(1, room))
      expect(view.shown.some(item => item.status === 'active')).toBe(true)
    }
  }
})

test('with everything done the window shows the end', async () => {
  const view = windowTodos(list('done', 'done', 'done', 'done', 'done', 'done'), 4)
  expect(view.shown.at(-1)?.id).toBe(6)
  expect(view.below).toBe(0)
})

test('the reminder names the tool and lists the items', () => {
  const text = reminder('mcp__session-sidebar__todo', { nextId: 2, items: [{ id: 1, text: 'Ship it', status: 'pending' }] })
  expect(text).toContain('`mcp__session-sidebar__todo`')
  expect(text.endsWith('1. [ ] Ship it')).toBe(true)
  expect(reminder('t', EMPTY_TODOS)).toContain('The todo list is empty.')
})
