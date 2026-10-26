import { expect, test } from 'claude-code/testing'

import { CACHE_TTL_MS, EMPTY_CACHE, afterStep, cacheState, priceOf } from './cache'
import { duration } from './format'

const MIN = 60_000

function usage(read: number, written: number, model = 'claude-opus-5-5') {
  return { model, input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: written }
}

test('a warm request is no cold write, even when it writes a lot', async () => {
  // The last prompt was 25k; this one reads it all and writes a 15k file.
  const before = { ...EMPTY_CACHE, promptTokens: 25_000 }
  const after = afterStep(before, usage(25_000, 15_000), 0)
  expect(after.coldWrites).toEqual([])
  expect(after.hitPercent).toBe(62)
  expect(after.promptTokens).toBe(40_010)
})

test('a request that re-reads too little of a big prompt is a cold write', async () => {
  const before = { ...EMPTY_CACHE, promptTokens: 100_000 }
  const after = afterStep(before, usage(0, 100_000), 5)
  expect(after.coldWrites).toEqual([{ at: 5, tokens: 100_000, usd: 0.8 }])
})

test('no cold write on the first request, after compaction, or for a small prompt', async () => {
  expect(afterStep(EMPTY_CACHE, usage(0, 90_000), 0).coldWrites).toEqual([])
  const compacted = { ...EMPTY_CACHE, promptTokens: 100_000, isCompacted: true }
  const after = afterStep(compacted, usage(0, 30_000), 0)
  expect(after.coldWrites).toEqual([])
  expect(after.isCompacted).toBe(false)
  expect(afterStep({ ...EMPTY_CACHE, promptTokens: 10_000 }, usage(0, 10_000), 0).coldWrites).toEqual([])
})

test('the cache state counts down from the last request', async () => {
  expect(cacheState(EMPTY_CACHE, 0, duration)).toEqual({ color: 'inactive', text: 'no request yet' })
  const cache = { ...EMPTY_CACHE, lastRequestAt: 0 }
  expect(cacheState(cache, 10 * MIN, duration)).toEqual({ color: 'success', text: 'warm · 50m left' })
  expect(cacheState(cache, 55 * MIN, duration)).toEqual({ color: 'warning', text: 'warm · 5m left' })
  expect(cacheState(cache, CACHE_TTL_MS + 5 * MIN, duration)).toEqual({ color: 'error', text: 'cold · 5m ago' })
  expect(cacheState({ ...cache, isCompacted: true }, 0, duration).text).toBe('reset by compaction')
})

test('prices match the most specific family', async () => {
  expect(priceOf('claude-opus-5-5[1m]')).toEqual({ read: 0.2, write: 8 })
  expect(priceOf('claude-opus-5')).toEqual({ read: 0.5, write: 10 })
  expect(priceOf('claude-fable-5-1')).toEqual({ read: 0.25, write: 20 })
  expect(priceOf('mystery')).toBe(null)
  expect(priceOf(null)).toBe(null)
})
