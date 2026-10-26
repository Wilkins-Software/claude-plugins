import { expect, test } from 'claude-code/testing'

import { compact, duration, effortText, prettyModel, usd } from './format'

test('model ids read as names', async () => {
  expect(prettyModel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(prettyModel('opus')).toBe('Opus')
})

test('numbers, money, durations and effort', async () => {
  expect(compact(999)).toBe('999')
  expect(compact(116_400)).toBe('116k')
  expect(compact(1_000_000)).toBe('1.0M')
  expect(usd(2.019)).toBe('$2.02')
  expect(usd(123.4)).toBe('$123')
  expect(duration(59 * 60_000)).toBe('59m')
  expect(duration(125 * 60_000)).toBe('2h 5m')
  expect(duration(-5)).toBe('0m')
  expect(effortText('high')).toBe('high')
  expect(effortText(32_000)).toBe('32k budget')
})
