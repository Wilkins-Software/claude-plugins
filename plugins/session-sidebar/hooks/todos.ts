import type { Todo, TodoStatus, Todos } from '../types'

const STATUSES: readonly TodoStatus[] = ['pending', 'active', 'done']

export const EMPTY_TODOS: Todos = { nextId: 1, items: [] }

function isStatus(value: unknown): value is TodoStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
}

// Puts `item` before the item with id `before`, or last when there is none.
function place(items: Todo[], item: Todo, before: unknown): Todo[] {
  const at = items.findIndex(one => one.id === before)

  return at === -1 ? [...items, item] : [...items.slice(0, at), item, ...items.slice(at)]
}

// Applies the model's operations in order. Any bad one rejects the whole batch
// with a message for the model, so a half-applied list never shows.
export function apply(list: Todos, ops: unknown): Todos | string {
  if (!Array.isArray(ops)) return 'ops must be a list'
  let { nextId, items } = list
  for (const [index, raw] of ops.entries()) {
    const at = `ops[${index}]`
    if (typeof raw !== 'object' || raw === null) return `${at}: must be an object`
    const op = raw as Record<string, unknown>
    if (op.status !== undefined && !isStatus(op.status)) return `${at}: status must be pending, active or done`
    if (op.before !== undefined && !Number.isInteger(op.before)) return `${at}: before must be an item id`
    const status = op.status as TodoStatus | undefined
    const text = typeof op.text === 'string' ? op.text.trim().replace(/\s+/g, ' ') : undefined
    const found = Number.isInteger(op.id) ? items.find(item => item.id === op.id) : undefined
    // One active item: starting one sets any other active one back to pending.
    const settle = (id: number) =>
      status === 'active'
        ? items.map(item => (item.id !== id && item.status === 'active' ? { ...item, status: 'pending' as const } : item))
        : items

    switch (op.op) {
      case 'add': {
        if (!text) return `${at}: add needs text`
        items = place(settle(nextId), { id: nextId, text, status: status ?? 'pending' }, op.before)
        nextId += 1
        break
      }
      case 'update': {
        if (!found) return `${at}: no item with id ${JSON.stringify(op.id)}`
        const changed: Todo = { ...found, text: text || found.text, status: status ?? found.status }
        const rest = settle(found.id)
        if (op.before === undefined || op.before === found.id) {
          items = rest.map(item => (item.id === found.id ? changed : item))
        } else {
          items = place(rest.filter(item => item.id !== found.id), changed, op.before)
        }
        break
      }
      case 'remove': {
        if (!found) return `${at}: no item with id ${JSON.stringify(op.id)}`
        items = items.filter(item => item.id !== found.id)
        break
      }
      case 'clear_done':
        items = items.filter(item => item.status !== 'done')
        break
      case 'clear_all':
        items = []
        break
      default:
        return `${at}: op must be add, update, remove, clear_done or clear_all`
    }
  }

  return { nextId, items }
}

export function describe(list: Todos): string {
  if (list.items.length === 0) return 'The todo list is empty.'
  const mark = { pending: '[ ]', active: '[>]', done: '[x]' }

  return list.items.map(item => `${item.id}. ${mark[item.status]} ${item.text}`).join('\n')
}

export type TodoWindow = { shown: Todo[]; above: number; below: number }

// The items that fit in `room` rows, around the active item (else the first
// pending one, else the last). An `n more` marker takes a row of its own, and
// below three rows there are no markers: the header's count says the rest.
export function windowTodos(items: Todo[], room: number): TodoWindow {
  const rows = Math.max(1, room)
  if (items.length <= rows) return { shown: items, above: 0, below: 0 }
  const active = items.findIndex(item => item.status === 'active')
  const pending = items.findIndex(item => item.status === 'pending')
  const focus = active !== -1 ? active : pending !== -1 ? pending : items.length - 1
  const hasMarkers = rows >= 3
  let slots = rows
  let start = 0
  // Markers shrink the slots, which can move the window; two passes settle it.
  for (let pass = 0; pass < 3; pass++) {
    start = Math.max(0, Math.min(focus - Math.floor((slots - 1) / 2), items.length - slots))
    if (!hasMarkers) break
    const markers = (start > 0 ? 1 : 0) + (start + slots < items.length ? 1 : 0)
    const next = rows - markers
    if (next === slots) break
    slots = next
  }
  const shown = items.slice(start, start + slots)

  return hasMarkers
    ? { shown, above: start, below: items.length - start - shown.length }
    : { shown, above: 0, below: 0 }
}

// Rides along with each prompt the user types, where the model reads it next to
// the ask; the system prompt's section alone is easy to pass over.
export function reminder(tool: string, list: Todos): string {
  return [
    `Session todo list (the user's sidebar, kept with \`${tool}\`): if this message gives you a task to do, add it as one short item, or mark the matching item active, before you start, and mark it done when it is finished. Skip this for a plain question.`,
    'Current list:',
    describe(list),
  ].join('\n')
}
