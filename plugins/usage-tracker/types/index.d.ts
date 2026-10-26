export type UsageWindow = {
  /** The API's key: `five_hour`, `seven_day`, `seven_day_<model>`. */
  id: string
  label: string
  percent: number
  /** Epoch ms; null when the API gave none. */
  resetsAt: number | null
}

export type Snapshot = {
  windows: UsageWindow[]
  /** Epoch ms of the last successful read. */
  fetchedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-tracker': {
      snapshot: Snapshot | null
      error: string | null
      /** Bumped by the clock so countdowns redraw between reads. */
      tick: number
      /** Raw body of the last usage response, for /usage-tracker:raw. */
      raw: string | null
    }
  }
}
