import type { UsageWindow } from '../types'

const BAR_WIDTH = 10
// The band's border and its horizontal padding.
const FRAME_COLUMNS = 6
export const SEPARATOR = '  │  '

export function bar(percent: number, width: number): { filled: string; empty: string } {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

  return { filled: '━'.repeat(filled), empty: '━'.repeat(width - filled) }
}

export function colorFor(percent: number): 'success' | 'warning' | 'error' {
  if (percent >= 80) return 'error'
  if (percent >= 50) return 'warning'

  return 'success'
}

// An estimate since the last read is marked with a leading `~`.
export function percentText(window: Pick<UsageWindow, 'percent' | 'isEstimate'>): string {
  return `${window.isEstimate ? '~' : ''}${Math.round(window.percent)}%`
}

export type Layout = {
  /** One line with separators, or one aligned line per window. */
  mode: 'row' | 'stack'
  barWidth: number
  /** Labels are padded to this in a stack so the bars line up. */
  labelWidth: number
  /** `resets ` when there's room, `↻ ` when tight; null drops the countdown. */
  resetsPrefix: string | null
}

// Picks the roomiest layout that fits `columns`, the band's width.
export function layoutFor(windows: UsageWindow[], resets: (string | null)[], columns: number): Layout {
  const inner = columns - FRAME_COLUMNS
  const resetsWidth = (prefix: string, index: number) => {
    const text = resets[index]

    return text == null ? 0 : 1 + prefix.length + text.length
  }

  const rowWidth = windows.reduce(
    (sum, window, index) =>
      sum +
      (index > 0 ? SEPARATOR.length : 0) +
      window.label.length + 1 + BAR_WIDTH + 1 + percentText(window).length +
      resetsWidth('resets ', index),
    0,
  )
  const labelWidth = Math.max(0, ...windows.map(window => window.label.length))
  if (rowWidth <= inner) {
    return { mode: 'row', barWidth: BAR_WIDTH, labelWidth, resetsPrefix: 'resets ' }
  }

  // Stacked: label, bar, a right-aligned percent, then the countdown.
  const fixed = labelWidth + 1 + 1 + '~100%'.length
  for (const [prefix, minBar] of [['resets ', 8], ['↻ ', 4]] as const) {
    const widest = Math.max(0, ...windows.map((_, index) => resetsWidth(prefix, index)))
    const barWidth = Math.min(20, inner - fixed - widest)
    if (barWidth >= minBar) return { mode: 'stack', barWidth, labelWidth, resetsPrefix: prefix }
  }

  return { mode: 'stack', barWidth: Math.max(3, Math.min(20, inner - fixed)), labelWidth, resetsPrefix: null }
}
