export type WindowKind = 'session' | 'weekly' | 'scoped'

export type UsageWindow = {
  /** `five_hour`, `seven_day`, or `<limit kind>:<scope name>`. */
  id: string
  kind: WindowKind
  label: string
  percent: number
  /** Epoch ms; null when the API gave none. */
  resetsAt: number | null
  /** How long the window runs, for pace; null when unknown. */
  periodMs: number | null
  /** A scoped window's allowance as a fraction of the weekly limit (0.5). */
  weeklyShare: number | null
  /** Lower-case model name a scoped window counts (`fable`); null otherwise. */
  model: string | null
  /** True once moved by a local estimate since the last real read. */
  isEstimate: boolean
}

export type Snapshot = {
  /** SNAPSHOT_VERSION of the code that wrote it. */
  version: number
  windows: UsageWindow[]
  /** Epoch ms of the read these figures came from. */
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

/** One read of the usage endpoint, for the history strip. */
export type Attempt = {
  /** Epoch ms the read finished. */
  at: number
  /** HTTP status; null when no response arrived. */
  status: number | null
  /** `ok`, or why it failed. */
  outcome: 'ok' | FailureKind
}

export type Schedule = {
  /** Epoch ms of the last attempt, failed or not. */
  lastAt: number
  /** Current backoff after consecutive failures; 0 when healthy. */
  backoffMs: number
  /** Epoch ms before which nobody retries; 0 when healthy. */
  retryAt: number
  /** Epoch ms until which one session holds the read; others wait. */
  leaseUntil: number
}

/** What every session shares through the plugin's store. */
export type Shared = {
  snapshot: Snapshot | null
  failure: Failure | null
  schedule: Schedule
  raw: string | null
  /** The last few reads by any session, oldest first. */
  history: Attempt[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-tracker': {
      snapshot: Snapshot | null
      failure: Failure | null
      /** Bumped by the clock so countdowns redraw between reads. */
      tick: number
      /** Raw body of the last usage response, for /usage-raw. */
      raw: string | null
      /** The last few reads by any session, oldest first. */
      history: Attempt[]
    }
  }
}
