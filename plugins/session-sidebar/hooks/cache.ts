import type { Cache } from '../types'

// Subscription sessions cache for an hour.
export const CACHE_TTL_MS = 60 * 60 * 1000
const WARNING_MS = 10 * 60_000
// A request that reads less than this share of the previous prompt from cache,
// after a prompt this big, re-wrote it: a cold write.
const COLD_READ_SHARE = 0.5
const COLD_MIN_TOKENS = 20_000
// $ per million tokens, [cache read, 1h cache write], from cache-tax (MIT, Karan Bansal), October 2026.
// More specific families first: a model id takes the first row it matches.
const PRICES: Array<[string, number, number]> = [
  ['fable-5-1', 0.25, 20],
  ['fable-5', 1, 20],
  ['opus-5-5', 0.2, 8],
  ['opus-5', 0.5, 10],
  ['opus-4', 0.5, 10],
  ['sonnet-5-5', 0.1, 4],
  ['sonnet-5', 0.2, 4],
  ['sonnet', 0.3, 6],
  ['haiku-5-5', 0.01, 0.2],
  ['haiku', 0.1, 2],
]

export const EMPTY_CACHE: Cache = {
  lastRequestAt: null,
  isCompacted: false,
  hitPercent: null,
  promptTokens: null,
  coldWrites: [],
}

export function priceOf(model: string | null): { read: number; write: number } | null {
  const id = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  const row = PRICES.find(([family]) => id.includes(family))

  return row ? { read: row[1], write: row[2] } : null
}

export type StepUsage = {
  model: string
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// The cache after a main-loop request answered at `now` with `usage`.
export function afterStep(cache: Cache, usage: StepUsage, now: number): Cache {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const previous = cache.promptTokens
  const isCold =
    !cache.isCompacted &&
    previous !== null &&
    previous >= COLD_MIN_TOKENS &&
    usage.cache_read_input_tokens < COLD_READ_SHARE * previous
  const price = priceOf(usage.model)
  const written = usage.cache_creation_input_tokens

  return {
    lastRequestAt: now,
    isCompacted: false,
    hitPercent: prompt > 0 ? Math.round((usage.cache_read_input_tokens / prompt) * 100) : null,
    promptTokens: prompt,
    coldWrites: isCold
      ? [...cache.coldWrites, { at: now, tokens: written, usd: price ? (written * price.write) / 1e6 : null }]
      : cache.coldWrites,
  }
}

export type CacheState = { color: 'inactive' | 'error' | 'warning' | 'success'; text: string }

export function cacheState(cache: Cache, now: number, duration: (ms: number) => string): CacheState {
  if (cache.isCompacted) return { color: 'inactive', text: 'reset by compaction' }
  if (cache.lastRequestAt === null) return { color: 'inactive', text: 'no request yet' }
  const left = cache.lastRequestAt + CACHE_TTL_MS - now
  if (left <= 0) return { color: 'error', text: `cold · ${duration(-left)} ago` }

  return { color: left < WARNING_MS ? 'warning' : 'success', text: `warm · ${duration(left)} left` }
}
