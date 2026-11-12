/** One usage window as the engine reports it: which one, percent used (0-100), when it resets. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * The prompt cache as last seen on the main thread: when the last request
 * started (clock ms, 0 before the first), the context the next request
 * re-sends, the model's context window, the model id and the effort the
 * request asked for (a level or a token budget; null when unknown or the
 * model takes none).
 */
export type CacheFacts = { lastAt: number; ctx: number; window: number; model: string | null; effort: string | number | null }

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

/**
 * Keep Warm for this session: whether it is on (null: as the setting says),
 * when the last real main-thread request started, and the pings sent since
 * then and over the session.
 */
export type KeepWarm = {
  on: boolean | null
  since: number
  streak: number
  pings: number
  usd: number
  lastPingAt: number
  /** Pings that found the cache already gone and paid a full write. */
  missed: number
}

/**
 * What the engine itself said about the cache: the TTL it caches with, and a
 * model switched to since the last request (its cache starts cold).
 */
export type EngineCache = { ttl: '5m' | '1h' | null; switchedTo: string | null }

/**
 * What this repo keeps switched for every session in it, over the plugin
 * settings; null follows the settings. `root` is the repo's folder, a
 * worktree read as the repo it belongs to; null until the session knows it.
 */
export type RepoPrefs = { root: string | null; guard: boolean | null; warm: boolean | null }

declare module 'claude-code' {
  interface PluginState {
    'cache-meter': {
      facts: Shaped<CacheFacts | null>
      limits: Shaped<Limit[]>
      stats: Shaped<Stats>
      sessionUsd: Shaped<number | null>
      warm: Shaped<KeepWarm>
      engine: Shaped<EngineCache>
      /** The cold send guard switched for this session; null follows the setting. */
      guard: Shaped<boolean | null>
      repo: Shaped<RepoPrefs>
    }
  }
}
