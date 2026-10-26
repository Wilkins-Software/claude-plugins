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

export type FailureKind = 'rate-limited' | 'auth' | 'no-login' | 'server' | 'network' | 'bad-response'

export type Failure = {
  kind: FailureKind
  /** HTTP status, when there was a response. */
  status: number | null
  /** Epoch ms of the next automatic attempt. */
  retryAt: number
}

export type Schedule = {
  /** Epoch ms before which timers and turns don't read again. */
  nextAt: number
  /** Current backoff after consecutive failures; 0 when healthy. */
  backoffMs: number
  /** Epoch ms of the last attempt, failed or not. */
  lastAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-tracker': {
      snapshot: Snapshot | null
      failure: Failure | null
      /** Kept in state so a reload honours a backoff instead of refetching at once. */
      schedule: Schedule
      /** Bumped by the clock so countdowns redraw between reads. */
      tick: number
      /** Raw body of the last usage response, for /usage-tracker:raw. */
      raw: string | null
    }
  }
}
