import { expect, test } from 'claude-code/testing'

import { layoutFor, percentText } from './layout'
import { parseUsage } from './usage'
import { BODY } from '../tests/fixtures'

test('one row when it fits, an aligned stack when it does not', async () => {
  const { windows } = parseUsage(BODY, 0)
  const resets = ['3h10m', '4d11h', '4d11h']
  expect(layoutFor(windows, resets, 120).mode).toBe('row')
  const stack = layoutFor(windows, resets, 80)
  expect(stack).toMatchObject({ mode: 'stack', labelWidth: 5, resetsPrefix: 'resets ' })
  expect(layoutFor(windows, resets, 30).resetsPrefix).toBe('↻ ')
  expect(layoutFor(windows, resets, 20).resetsPrefix).toBe(null)
})

test('an estimate reads with a ~', async () => {
  expect(percentText({ percent: 40, isEstimate: true })).toBe('~40%')
  expect(percentText({ percent: 40, isEstimate: false })).toBe('40%')
})
