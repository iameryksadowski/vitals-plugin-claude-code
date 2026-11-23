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

/**
 * Who and where the session runs, for the account fields: the account's label
 * and config folder, its e-mail (shown only), the permission mode, output
 * style, folder and branch as last seen, the effort the settings ask for, the
 * session's model and the person's time zone (minutes east of UTC).
 */
export type Who = {
  label: string
  /**
   * Where the label comes from: set with /vitals account, the accountLabels
   * setting, a name the config folder carries, its letter, or `single` when
   * this is the only account on the machine (then the band and the line leave
   * it out).
   */
  labelFrom: 'own' | 'setting' | 'folder' | 'letter' | 'single'
  /** The account's id: its config folder's name (`.claude`, `.claude-b`). */
  id: string
  /** The label the account has without a name of yours: from accountLabels, its config folder's name, or its letter. Kept beside a rename. */
  auto: string
  autoFrom: 'setting' | 'folder' | 'letter'
  /** Whether this is the only account on the machine. */
  alone: boolean
  configDir: string
  email: string | null
  mode: string | null
  style: string | null
  dir: string | null
  branch: string | null
  effort: string | null
  model: string | null
  tzMin: number
}

/**
 * Fields chosen with /vitals, over the plugin settings; null follows the
 * settings. `status` is where the status line is pinned.
 */
export type Layout = { band: string[] | null; line: string[] | null; status: 'auto' | 'on' | 'off' | null }

/** The last usage reading sent to the local Alfred engine: when, and how it went. */
export type AlfredSend = { at: number; ok: boolean; status: number; error: string | null; sent: number }

/** One moment of the session's timeline: a message sent, or a reply with how long it took and how many tools it ran. */
export type TimelineEntry = {
  at: number
  /**
   * Who sent it: you, Claude's reply, another Claude session, a subagent handing back, a background
   * task finishing, a scheduled or looped prompt, or the app itself.
   */
  who: 'you' | 'claude' | 'session' | 'agent' | 'task' | 'schedule' | 'system'
  text: string | null
  ms: number | null
  tools: number | null
  /** The sending session, for a message from another session. */
  from?: string | null
}

/**
 * The context as /context counts it, read now and then: the auto-compact
 * threshold in tokens (null when auto-compact is off or unknown), whether it
 * is on, the window, the largest categories and the heaviest MCP servers.
 */
export type ContextInfo = {
  at: number
  /** Every category's tokens, as /context totals them. */
  total: number
  autoOn: boolean | null
  threshold: number | null
  window: number
  /** What occupies the window now, as /context lists it: no free space, reserve or deferred schemas. */
  categories: Array<{ name: string; tokens: number }>
  /** Tool schemas loaded on demand: outside the window until searched for. */
  deferred: number
  /** The reserve auto-compact keeps free. */
  buffer: number
  /** MCP servers by tool schema size: in the window now, and loaded on demand. */
  mcp: Array<{ server: string; label: string; tokens: number; deferred: number }>
  /** Images in the messages the next request carries: how many, their estimated tokens, and how many a tool returned. Absent before the first count. */
  images?: { count: number; tokens: number; inTools: number }
}

/** The pane's open tab. */
export type PaneTab = 'now' | 'context' | 'cost' | 'timeline' | 'settings'

/** One usage window of the account, as the API reports it. */
export type VitalsLimit = { kind: string; percentUsed: number; resetsAt: string | null }

/**
 * What `$.vitals.snapshot()` gives another plugin: this session's account,
 * cache, context and limits as the plugin last drew them. Never the e-mail, never
 * anything said in the session. Times are Unix milliseconds, money is USD at API list prices.
 */
export type VitalsSnapshot = {
  at: number
  sessionId: string
  /** `label` is what the band shows and anyone can change; `id` is the config folder's name and stays. */
  account: { label: string; auto: string; id: string; configDir: string }
  model: string | null
  effort: string | number | null
  cache: {
    state: 'none' | 'warm' | 'soon' | 'cold'
    leftMs: number
    idleMs: number
    /** Why a cold cache's idle time is not known. */
    why: 'compacted' | 'unknown' | null
    ttl: '5m' | '1h'
    nextUsd: number | null
    coldUsd: number | null
  }
  context: {
    tokens: number | null
    window: number | null
    percent: number | null
    autoCompactOn: boolean | null
    autoCompactAtPercent: number | null
    /** Why compacting now is worth it, or null. */
    advice: string | null
  }
  limits: VitalsLimit[]
  session: { requests: number; hitPercent: number | null; usd: number | null }
}

/** The data other plugins read: list this plugin under `dependencies` and call `$.vitals.snapshot()`. */
export type Vitals = {
  /** The latest reading, refreshed every 15 seconds and after each reply; null before the first. */
  snapshot: () => Promise<VitalsSnapshot | null>
}

declare module 'claude-code' {
  interface EngineInterface {
    vitals: Vitals
  }

  interface PluginState {
    'vitals': {
      facts: Shaped<CacheFacts | null>
      limits: Shaped<Limit[]>
      stats: Shaped<Stats>
      sessionUsd: Shaped<number | null>
      warm: Shaped<KeepWarm>
      engine: Shaped<EngineCache>
      /** The cold send guard switched for this session; null follows the setting. */
      guard: Shaped<boolean | null>
      repo: Shaped<RepoPrefs>
      who: Shaped<Who>
      layout: Shaped<Layout>
      alfred: Shaped<AlfredSend>
      /** The context was compacted and no request has written its cache yet. */
      compacted: Shaped<boolean>
      timeline: Shaped<TimelineEntry[]>
      ctxinfo: Shaped<ContextInfo | null>
      resumed: Shaped<number | null>
      tab: Shaped<PaneTab>
    }
  }
}
