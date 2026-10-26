import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionContextUsage, Timer } from 'claude-code'

import type { Info, Todo } from '../types'
import { EMPTY_CACHE, afterStep, cacheState, priceOf } from './cache'
import { colorFor, compact, duration, effortText, prettyModel, usd } from './format'
import { EMPTY_TODOS, apply, describe, reminder, windowTodos } from './todos'

const PANE = 'session-sidebar'
const TITLE = 'Session'
const TOOL = 'mcp__session-sidebar__todo'
// The card's widest; narrower panes get the pane's width.
const MAX_CARD = 44
// The rounded border and its horizontal padding.
const FRAME_COLUMNS = 6
// The todo card's border rows and its header.
const TODO_CHROME_ROWS = 3
const TICK_MS = 15_000
const FRAME_MS = 120
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const PROMPT = `# Session todo list

The user sees a todo list for this session in a sidebar, kept with the \`${TOOL}\` tool.
- When the user gives you a task to do (not a plain question), add it as one short item (under 60 characters) before you start.
- Mark an item \`active\` when you start on it and \`done\` when it is finished; keep one item active at a time.
- "The todo list", "my todos" and the like mean this list: add, remove, reword or reorder its items with the tool when asked.
- This is separate from your own TodoWrite planning list; don't mirror every planning step here, only the user's tasks.`

const EMPTY_INFO: Info = {
  model: null,
  effort: null,
  tokens: null,
  window: null,
  percent: null,
  costUsd: null,
  turns: 0,
  startedAt: null,
}
// Change a tag when its type's fields change: a reload keeps what older code stored.
const info = atom({ plugin: 'session-sidebar', key: 'info' } as const, EMPTY_INFO, { shape: 'info-2' })
const todos = atom({ plugin: 'session-sidebar', key: 'todos' } as const, EMPTY_TODOS, { shape: 'todos-1' })
const cache = atom({ plugin: 'session-sidebar', key: 'cache' } as const, EMPTY_CACHE, { shape: 'cache-1' })
const tick = atom({ plugin: 'session-sidebar', key: 'tick' } as const, 0)
const frame = atom({ plugin: 'session-sidebar', key: 'frame' } as const, 0)
const working = atom({ plugin: 'session-sidebar', key: 'working' } as const, false)

let spinner: Timer | null = null

function fromContext(context: SessionContextUsage): Pick<Info, 'tokens' | 'window' | 'percent'> {
  return { tokens: context.tokens ?? null, window: context.window, percent: context.percent ?? null }
}

async function refresh($: EngineInterface): Promise<void> {
  const [model, usage, turns] = await Promise.all([$.session.model(), $.session.usage(), $.session.turns()])
  await update($, info, current => ({
    ...current,
    model: current.model ?? model,
    ...fromContext(usage.context),
    costUsd: usage.cost?.usd ?? null,
    turns,
    startedAt: usage.startedAt,
  }))
}

// The spinner turns while a turn runs with an item active, and stops otherwise.
async function syncSpinner($: EngineInterface): Promise<void> {
  const [list, isWorking] = await Promise.all([read($, todos), read($, working)])
  const isSpinning = isWorking && list.items.some(item => item.status === 'active')
  if (isSpinning && spinner === null) {
    spinner = $.clock.every(FRAME_MS, () => void update($, frame, n => (n + 1) % SPINNER.length))
  } else if (!isSpinning && spinner !== null) {
    spinner.cancel()
    spinner = null
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.command.register({ name: 'sidebar', description: 'Open the session sidebar' }),
      $.tool.register({
        name: 'todo',
        description:
          "Edit the session todo list the user sees in the sidebar. Ops run in order; the result lists every item with its id. Use for the user's own tasks in this session and whenever they mention 'the todo list'.",
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: {
            ops: {
              type: 'array',
              description: 'Changes to make, in order. Pass an empty list to read the list.',
              items: {
                type: 'object',
                properties: {
                  op: { type: 'string', enum: ['add', 'update', 'remove', 'clear_done', 'clear_all'] },
                  id: { type: 'integer', description: 'The item, for update and remove.' },
                  text: { type: 'string', description: 'Short task text, for add, or a new wording for update.' },
                  status: { type: 'string', enum: ['pending', 'active', 'done'] },
                  before: { type: 'integer', description: 'Place the item before this id (add or update).' },
                },
                required: ['op'],
              },
            },
          },
          required: ['ops'],
        },
      }),
    ])
    await refresh($)
    // A reload mid-turn would otherwise leave the spinner waiting for a turn.start it missed.
    await update($, working, () => false)
    const now = await $.clock.now()
    await update($, tick, () => now)
    $.clock.every(TICK_MS, () => void $.clock.now().then(time => update($, tick, () => time)))
    // Unasked, the engine seats it only on a wide terminal; /sidebar opens it anywhere.
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const result = await next(e)
    // `/clear` and an in-process resume start another conversation in this process.
    if (e.reason === 'clear' || e.reason === 'resume') {
      await Promise.all([
        update($, todos, () => EMPTY_TODOS),
        update($, cache, () => EMPTY_CACHE),
        update($, info, current => ({ ...EMPTY_INFO, model: current.model, effort: current.effort })),
      ])
      await syncSpinner($)
    }

    return result
  })

  on('command.run', { command: 'sidebar' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return { text: opened.isPlaced ? 'Session sidebar opened.' : `Session sidebar waiting: ${opened.reason}` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL)) return composed

    return { sections: [...composed.sections, { id: 'session-sidebar:todo', text: PROMPT, scope: 'session' }] }
  })

  // The user's own prompts only: not commands, notifications, peers or plugins.
  on('prompt.submit', async ($, e, next) => {
    const isUsers = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    if (!isUsers || e.command !== undefined || e.isMeta) return next(e)
    const list = await read($, todos)

    return next({ ...e, context: [...(e.context ?? []), reminder(TOOL, list)] })
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: "The session todo list is the user's; only the main conversation edits it." }
    const ops = (e as unknown as { ops?: unknown }).ops
    let error: string | null = null
    const changed = await update($, todos, list => {
      const result = apply(list, ops)
      error = typeof result === 'string' ? result : null

      return typeof result === 'string' ? list : result
    })
    if (error !== null) return { deny: error }
    await syncSpinner($)

    return { result: describe(changed) }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, working, () => true)
      await syncSpinner($)
      // After /clear the session's clock starts over.
      if ((await read($, info)).startedAt === null) await refresh($).catch(() => undefined)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await update($, working, () => false)
      await syncSpinner($)
    }

    return result
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    if (isMain) {
      await update($, info, current => ({
        ...current,
        model: e.model,
        effort: e.effort === undefined ? null : effortText(e.effort),
      }))
    }
    const result = yield* next(e)
    const usage = result.usage
    // A request that got no answer touched no cache, and leaves its clock alone.
    if (isMain && usage !== null) {
      const now = await $.clock.now()
      await update($, cache, current => afterStep(current, usage, now))
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    const turns = await $.session.turns()
    await update($, info, current => ({
      ...current,
      ...fromContext(e.context),
      costUsd: e.cost?.usd ?? current.costUsd,
      turns,
    }))

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // A precompute installs nothing and a skipped compaction kept the transcript.
    const isApplied = e.trigger !== 'precompute' && !('skip' in result && result.skip !== undefined)
    if (e.agentId === undefined && isApplied) {
      await update($, cache, current => ({ ...current, isCompacted: true }))
      // A failed read leaves the old figures up; the next measure corrects them.
      await refresh($).catch(() => undefined)
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [value, list, cached, now, spin, isWorking] = await Promise.all([
      read($, info),
      read($, todos),
      read($, cache),
      read($, tick),
      read($, frame),
      read($, working),
    ])
    const cardWidth = Math.min(MAX_CARD, e.props.bodyColumns)
    const inner = Math.max(1, cardWidth - FRAME_COLUMNS)
    const card = (key: string, children: RenderChildren) => (
      <Box key={key} flexDirection="column" width={cardWidth} borderStyle="round" borderDimColor paddingX={2}>
        {children}
      </Box>
    )
    const centered = (key: string, children: RenderChildren) => (
      <Box key={key} justifyContent="center">
        {children}
      </Box>
    )

    // Context.
    const percent = value.percent
    const color = percent === null ? undefined : colorFor(percent)
    const percentText = percent === null ? '—%' : `${percent}%`
    const barWidth = Math.max(1, inner - percentText.length - 1)
    const filled = percent === null ? 0 : Math.max(0, Math.min(barWidth, Math.round((percent / 100) * barWidth)))
    const facts = [
      value.tokens !== null && value.window !== null ? `${compact(value.tokens)}/${compact(value.window)}` : null,
      value.costUsd === null ? null : usd(value.costUsd),
      `${value.turns} ${value.turns === 1 ? 'turn' : 'turns'}`,
      value.startedAt === null ? null : duration(now - value.startedAt),
    ].filter(fact => fact !== null)

    // Cache.
    const state = cacheState(cached, now, duration)
    const price = priceOf(value.model)
    const context = value.tokens ?? 0
    const paid = cached.coldWrites.reduce((sum, write) => sum + (write.usd ?? 0), 0)
    const cacheFacts = [
      cached.hitPercent === null ? null : `${cached.hitPercent}% cached`,
      `${cached.coldWrites.length} cold ${cached.coldWrites.length === 1 ? 'write' : 'writes'}${paid > 0 ? ` ${usd(paid)}` : ''}`,
    ].filter(fact => fact !== null)
    const costs =
      price && context > 0 ? `rewrite ${usd((context * price.write) / 1e6)} · warm ${usd((context * price.read) / 1e6)}` : null

    // Todos: at most a quarter of the pane, the window following the active item.
    const room = Math.floor(e.props.scroll.bodyRows / 4) - TODO_CHROME_ROWS
    const done = list.items.filter(item => item.status === 'done').length
    const view = windowTodos(list.items, room)
    const todoRow = (item: Todo) => {
      const mark =
        item.status === 'done' ? '✔'
        : item.status === 'pending' ? '○'
        : isWorking ? (SPINNER[spin % SPINNER.length] ?? '▸')
        : '▸'
      const markColor = item.status === 'done' ? 'success' : item.status === 'active' ? 'claude' : 'inactive'
      return (
        <Box key={String(item.id)}>
          <Text color={markColor}>{`${mark} `}</Text>
          <Text
            wrap="truncate-end"
            dimColor={item.status === 'done'}
            strikethrough={item.status === 'done'}
            bold={item.status === 'active'}
          >
            {item.text}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" alignItems="center">
        {card(
          'context',
          <Box flexDirection="column">
            {centered(
              'model',
              <Text wrap="truncate-end">
                <Text bold>{value.model === null ? '—' : prettyModel(value.model)}</Text>
                {value.effort !== null && <Text dimColor>{` · ${value.effort}`}</Text>}
              </Text>,
            )}
            {centered(
              'bar',
              <Text>
                <Text color={color}>{'━'.repeat(filled)}</Text>
                <Text dimColor>{'━'.repeat(barWidth - filled)}</Text>
                <Text color={color} bold>{` ${percentText}`}</Text>
              </Text>,
            )}
            {centered(
              'facts',
              <Text dimColor wrap="truncate-end">
                {facts.join(' · ')}
              </Text>,
            )}
          </Box>,
        )}
        {card(
          'cache',
          <Box flexDirection="column">
            {centered(
              'state',
              <Text wrap="truncate-end">
                <Text color={state.color}>● </Text>
                <Text bold>cache </Text>
                <Text color={state.color}>{state.text}</Text>
              </Text>,
            )}
            {centered(
              'hits',
              <Text dimColor wrap="truncate-end">
                {cacheFacts.join(' · ')}
              </Text>,
            )}
            {centered(
              'costs',
              <Text dimColor wrap="truncate-end">
                {costs ?? 'rewrite cost after the first reply'}
              </Text>,
            )}
          </Box>,
        )}
        {card(
          'todos',
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              <Text bold>Todo</Text>
              {list.items.length > 0 && <Text dimColor>{`${done}/${list.items.length}`}</Text>}
            </Box>
            {list.items.length === 0 && (
              <Text dimColor wrap="truncate-end">
                Tasks you give Claude show here
              </Text>
            )}
            {view.above > 0 && <Text dimColor>{`↑ ${view.above} more`}</Text>}
            {view.shown.map(todoRow)}
            {view.below > 0 && <Text dimColor>{`↓ ${view.below} more`}</Text>}
          </Box>,
        )}
      </Box>
    )
  })
}
