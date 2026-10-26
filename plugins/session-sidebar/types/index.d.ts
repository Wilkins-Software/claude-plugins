export type Info = {
  /** The main loop's model: `/model`'s name, then the id each request names. */
  model: string | null
  /** The effort the last main-loop request was sent with; null before one. */
  effort: string | null
  /** Input tokens of the last response; null before one or after a compact. */
  tokens: number | null
  /** The model's context window, in tokens. */
  window: number | null
  /** `tokens` over `window`, 0 to 100. */
  percent: number | null
  costUsd: number | null
  turns: number
  /** Epoch ms the session began. */
  startedAt: number | null
}

export type TodoStatus = 'pending' | 'active' | 'done'

export type Todo = { id: number; text: string; status: TodoStatus }

export type Todos = { nextId: number; items: Todo[] }

/** A main-loop request that re-wrote a cold cache. */
export type ColdWrite = { at: number; tokens: number; usd: number | null }

export type Cache = {
  /** Epoch ms the last main-loop request went out; the cache's clock runs from it. */
  lastRequestAt: number | null
  /** True from a compaction until the next request: the old prefix is gone. */
  isCompacted: boolean
  /** Share of the last request's prompt served from cache, 0 to 100. */
  hitPercent: number | null
  /** Prompt tokens of the last request, cached or not; the next one is measured against it. */
  promptTokens: number | null
  coldWrites: ColdWrite[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-sidebar': {
      info: Shaped<Info>
      todos: Shaped<Todos>
      cache: Shaped<Cache>
      /** Epoch ms of the last clock tick, so countdowns redraw. */
      tick: number
      /** The active todo's spinner frame. */
      frame: number
      /** True while a main-loop turn runs; the spinner turns only then. */
      working: boolean
      /** The todo card shows every item that fits, not a quarter of the pane. */
      expanded: boolean
      /** The described list as the model last read it; null for none this conversation. */
      seen: string | null
    }
  }
}
