import { expect, test } from 'claude-code/testing'

import { fitHeight, layoutFor, percentText } from './layout'
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

test('a short band gives up the blank row, then the border, then the bars', async () => {
  // Three stacked windows and a pace line.
  expect(fitHeight(3, 1, 10)).toEqual({ hasMargin: true, hasBorder: true, isCompact: false, extraLines: 1 })
  expect(fitHeight(3, 1, 6)).toEqual({ hasMargin: false, hasBorder: true, isCompact: false, extraLines: 1 })
  expect(fitHeight(3, 1, 4)).toEqual({ hasMargin: false, hasBorder: false, isCompact: false, extraLines: 1 })
  expect(fitHeight(3, 1, 3)).toEqual({ hasMargin: false, hasBorder: false, isCompact: true, extraLines: 1 })
  // Bars without a border beat the one-line summary when they fit.
  expect(fitHeight(3, 0, 3)).toEqual({ hasMargin: false, hasBorder: false, isCompact: false, extraLines: 0 })
  // Four windows in three rows: the summary keeps its box.
  expect(fitHeight(4, 0, 3)).toEqual({ hasMargin: false, hasBorder: true, isCompact: true, extraLines: 0 })
  expect(fitHeight(3, 2, 1)).toEqual({ hasMargin: false, hasBorder: false, isCompact: true, extraLines: 0 })
})
