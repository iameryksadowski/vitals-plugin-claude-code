/** One usage window as the engine reports it: which one, percent used (0-100), when it resets. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * The prompt cache as last seen on the main thread: when the last request
 * started (clock ms, 0 before the first), the context the next request
 * re-sends, the model's context window and the model id.
 */
export type CacheFacts = { lastAt: number; ctx: number; window: number; model: string | null }

/** Token counts of one main-thread request, as the API reported them. */
export type Request = { at: number; read: number; write: number; uncached: number; output: number; model: string; usd: number | null }

/** Main-thread cache figures summed over the session. */
export type Stats = {
  requests: number
  read: number
  write: number
  uncached: number
  output: number
  /** What the cache reads saved against paying full input price for the same tokens. */
  savedUsd: number
  /** Requests that re-wrote most of a cached context: the cache had gone cold or the prefix broke. */
  coldWrites: number
  coldUsd: number
  last: Request | null
}

declare module 'claude-code' {
  interface PluginState {
    'cache-meter': {
      facts: Shaped<CacheFacts | null>
      limits: Shaped<Limit[]>
      stats: Shaped<Stats>
      sessionUsd: Shaped<number | null>
    }
  }
}
