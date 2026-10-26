import type { UsageWindow } from '../types'

const BAR_WIDTH = 10
// The band's border and its horizontal padding.
export const FRAME_COLUMNS = 6
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

  // Never wider than what's left, so a line can't outgrow a narrow band.
  return { mode: 'stack', barWidth: Math.max(1, Math.min(20, inner - fixed)), labelWidth, resetsPrefix: null }
}

export type Fit = {
  /** The blank row above the band. */
  hasMargin: boolean
  hasBorder: boolean
  /** One line of labels and percentages, no bars. */
  isCompact: boolean
  /** How many of the extra lines (pace, status) fit under the bars. */
  extraLines: number
}

// Fits the band to `maxRows`, the rows the engine gives it, so it never
// scrolls behind an `n more`. Gives up the roomiest parts first: the blank
// row, then the border, then the bars (a boxed one-line summary first, a
// bare one last); the extra lines go last.
export function fitHeight(contentRows: number, extraLines: number, maxRows: number): Fit {
  const options: Fit[] = [
    { hasMargin: true, hasBorder: true, isCompact: false, extraLines },
    { hasMargin: false, hasBorder: true, isCompact: false, extraLines },
    { hasMargin: false, hasBorder: false, isCompact: false, extraLines },
  ]
  for (const fit of options) {
    const rows = (fit.hasMargin ? 1 : 0) + (fit.hasBorder ? 2 : 0) + contentRows + fit.extraLines
    if (rows <= maxRows) return fit
  }

  // One line without bars: boxed when there's room, bare when there isn't.
  if (3 + extraLines <= maxRows) return { hasMargin: false, hasBorder: true, isCompact: true, extraLines }

  return { hasMargin: false, hasBorder: false, isCompact: true, extraLines: Math.max(0, Math.min(extraLines, maxRows - 1)) }
}

