export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`

  return String(n)
}

export function usd(n: number): string {
  return `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`
}

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// `claude-opus-5-5[1m]` and `opus` read as `Opus 5.5` and `Opus`.
export function prettyModel(model: string): string {
  const parts = model
    .replace(/\[.*\]$/, '')
    .replace(/^claude-/, '')
    .split('-')
    .filter(part => !/^\d{8}$/.test(part))
  const [family = model, ...version] = parts

  return [family.charAt(0).toUpperCase() + family.slice(1), version.join('.')].filter(Boolean).join(' ')
}

// A level as is; a thinking budget in tokens as `32k budget`.
export function effortText(effort: string | number): string {
  return typeof effort === 'number' ? `${compact(effort)} budget` : effort
}

export function colorFor(percent: number): 'success' | 'warning' | 'error' {
  if (percent >= 80) return 'error'
  if (percent >= 50) return 'warning'

  return 'success'
}
