// Pure cache math and formatting. Nothing here touches the engine.

export type Ttl = '1h' | '5m'

export const TTL_MS: Record<Ttl, number> = { '1h': 60 * 60 * 1000, '5m': 5 * 60 * 1000 }

/** Below this the warm countdown turns to a warning. */
export const SOON_MS: Record<Ttl, number> = { '1h': 10 * 60 * 1000, '5m': 60 * 1000 }

/** A cold send under this many context tokens is cheap enough to let through without a word. */
export const GUARD_MIN_TOKENS = 50_000

/** Keep Warm pings this long before the cache would expire. */
export const WARM_LEAD_MS: Record<Ttl, number> = { '1h': 5 * 60 * 1000, '5m': 45 * 1000 }
/** How long after the last real message Keep Warm goes on pinging. */
export const WARM_FOR_MS: Record<string, number> = { '1h': 1 * 3_600_000, '2h': 2 * 3_600_000, '4h': 4 * 3_600_000, '8h': 8 * 3_600_000 }

/** A request that writes at least this share of the previous context re-cached it: a cold write. */
export const COLD_WRITE_SHARE = 0.5
/** Contexts smaller than this never count as a cold write (the first turns of a session). */
export const COLD_WRITE_MIN = 20_000

/**
 * $ per million tokens: base input, output, cache read. A cache write is
 * 1.25x input on the 5m TTL and 2x on the 1h TTL. List prices, November 2026.
 * A row matches a model id only as a whole version: `opus-5` is Opus 5 and
 * never Opus 5.1, so a model this table does not know is priced at nothing
 * rather than at a neighbour's price. A date after the version still matches.
 */
export type Price = { name: string; input: number; output: number; read: number }
type Rate = Omit<Price, 'name'>

const PRICES: Array<[string, Rate]> = [
  ['fable-5-2', { input: 8, output: 40, read: 0.2 }],
  ['mythos-5-2', { input: 8, output: 40, read: 0.2 }],
  ['fable-5-1', { input: 10, output: 50, read: 0.25 }],
  ['mythos-5-1', { input: 10, output: 50, read: 0.25 }],
  ['fable-5', { input: 10, output: 50, read: 1 }],
  ['mythos-5', { input: 10, output: 50, read: 1 }],
  ['opus-5-5', { input: 4, output: 20, read: 0.2 }],
  ['opus-5', { input: 5, output: 25, read: 0.5 }],
  ['opus-4-8', { input: 5, output: 25, read: 0.5 }],
  ['opus-4-7', { input: 5, output: 25, read: 0.5 }],
  ['opus-4-6', { input: 5, output: 25, read: 0.5 }],
  ['opus-4-5', { input: 5, output: 25, read: 0.5 }],
  ['opus-4-1', { input: 15, output: 75, read: 1.5 }],
  ['opus-4', { input: 15, output: 75, read: 1.5 }],
  ['3-opus', { input: 15, output: 75, read: 1.5 }],
  ['sonnet-5-5', { input: 2, output: 10, read: 0.1 }],
  ['sonnet-5', { input: 2, output: 10, read: 0.2 }],
  ['sonnet-4-6', { input: 3, output: 15, read: 0.3 }],
  ['sonnet-4-5', { input: 3, output: 15, read: 0.3 }],
  ['sonnet-4', { input: 3, output: 15, read: 0.3 }],
  ['3-7-sonnet', { input: 3, output: 15, read: 0.3 }],
  ['3-5-sonnet', { input: 3, output: 15, read: 0.3 }],
  ['haiku-5-5', { input: 0.1, output: 0.5, read: 0.01 }],
  ['haiku-4-5', { input: 1, output: 5, read: 0.1 }],
  ['3-5-haiku', { input: 0.8, output: 4, read: 0.08 }],
  ['3-haiku', { input: 0.25, output: 1.25, read: 0.03 }],
]

/** Rows whose prompts over a threshold are priced higher: Haiku 5.5 past 100k, Sonnet 4.x past 200k. */
const LONG: Array<[string, number, Rate]> = [
  ['haiku-5-5', 100_000, { input: 0.5, output: 2.5, read: 0.05 }],
  ['sonnet-4-6', 200_000, { input: 6, output: 22.5, read: 0.6 }],
  ['sonnet-4-5', 200_000, { input: 6, output: 22.5, read: 0.6 }],
  ['sonnet-4', 200_000, { input: 6, output: 22.5, read: 0.6 }],
]

/** A model id as one lowercase run: no `[1m]` tags, dots, spaces or `@` (Bedrock and Vertex ids). */
const normalize = (model: string | null | undefined): string =>
  (model ?? '').toLowerCase().replace(/\[.*?\]/g, '').replace(/[\s.@:_]+/g, '-')

/** Whether `id` stands in `m` as a whole word and a whole version (a date may follow). */
const holds = (m: string, id: string): boolean => new RegExp(`(^|[^a-z0-9])${id}(?!-?\\d{1,2}(?!\\d))`).test(m)

const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku']

/** The model as people name it, read from its id: `claude-opus-5-5` is Opus 5.5, `claude-3-5-haiku-2024...` Haiku 3.5. */
export const modelName = (model: string | null | undefined): string | null => {
  const m = normalize(model)
  for (const f of FAMILIES) {
    const after = new RegExp(`(?:^|[^a-z0-9])${f}-(\\d{1,2})(?:-(\\d{1,2}))?(?!\\d)`).exec(m)
    if (after) return `${f[0]!.toUpperCase()}${f.slice(1)} ${after[1]}${after[2] ? `.${after[2]}` : ''}`
    const before = new RegExp(`(?:^|[^a-z0-9])(\\d)(?:-(\\d))?-${f}(?:$|[^a-z])`).exec(m)
    if (before) return `${f[0]!.toUpperCase()}${f.slice(1)} ${before[1]}${before[2] ? `.${before[2]}` : ''}`
  }
  return null
}

/** The price row for a model id, or null for one this table does not know. */
export const priceOf = (model: string | null | undefined, promptTokens = 0): Price | null => {
  const m = normalize(model)
  if (!m) return null
  const row = PRICES.find(([id]) => holds(m, id))
  if (!row) return null
  const long = LONG.find(([id, over]) => id === row[0] && promptTokens > over)
  return { name: modelName(m) ?? row[0], ...(long ? long[2] : row[1]) }
}

export const writeRate = (p: Price, ttl: Ttl): number => p.input * (ttl === '1h' ? 2 : 1.25)

/** What re-sending `ctx` tokens costs while the cache is warm (a read) and once it is cold (a write). */
export const warmUsd = (p: Price | null, ctx: number): number | null => (p ? (ctx * p.read) / 1e6 : null)
export const coldUsd = (p: Price | null, ctx: number, ttl: Ttl): number | null => (p ? (ctx * writeRate(p, ttl)) / 1e6 : null)

/** What one request cost: reads, writes, uncached input and output. */
export const requestUsd = (p: Price | null, r: { read: number; write: number; uncached: number; output: number }, ttl: Ttl): number | null =>
  p ? (r.read * p.read + r.write * writeRate(p, ttl) + r.uncached * p.input + r.output * p.output) / 1e6 : null

/** Dollars: whole above $100, cents above a cent, `<$0.01` below; `n/a` when the price is unknown. */
export const usd = (n: number | null): string => {
  if (n == null || !Number.isFinite(n)) return 'n/a'
  if (n <= 0) return '$0.00'
  if (n >= 99.995) return '$' + Math.round(n).toLocaleString('en-US')
  // Cents rounded half up on the decimal figure, not on its binary neighbour: $1.505 is $1.51.
  if (n >= 0.005) return '$' + (Math.round(Number((n * 100).toFixed(6))) / 100).toFixed(2)
  return '<$0.01'
}

/** Tokens: 950, 12k, 1.2M, 15M. Rounds up into the next unit rather than printing 1000k. */
export const tok = (n: number): string => {
  const v = Math.max(0, Math.round(n))
  if (v >= 999_500) {
    const m = v / 1e6
    return `${m >= 9.95 ? Math.round(m) : Number(m.toFixed(1))}M`
  }
  if (v >= 1000) return `${Math.round(v / 1000)}k`
  return String(v)
}

/** A duration as 45s, 18m, 2h 05m, 3d 4h. */
export const dur = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const mins = Math.floor(s / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${String(mins % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export const pct = (part: number, whole: number): number => (whole > 0 ? Math.min(100, Math.max(0, Math.round((part / whole) * 100))) : 0)

/** A share that never rounds up to a whole it has not reached: 99.6% of hits is 99%, not 100%. */
export const pctDown = (part: number, whole: number): number => (whole > 0 ? Math.min(100, Math.max(0, Math.floor((part / whole) * 100))) : 0)

export type CacheState = 'none' | 'warm' | 'soon' | 'cold'

export type CacheView = {
  state: CacheState
  /** Time since the last request started. */
  idleMs: number
  /** Time left before the cache lapses (0 when cold). */
  leftMs: number
  ctx: number
  window: number
  model: string | null
  effort: string | number | null
  price: Price | null
  warm: number | null
  cold: number | null
  /** Why a cold cache's idle time is not known: the context was compacted, or the session came back without it. */
  why?: 'compacted' | 'unknown'
}

/** Everything the band and the pane draw about the cache, at `now`. */
export const viewOf = (
  f: { lastAt: number; ctx: number; window: number; model: string | null; effort: string | number | null } | null,
  now: number,
  ttl: Ttl,
): CacheView => {
  const ctx = f?.ctx ?? 0
  const price = priceOf(f?.model, ctx)
  const base = { ctx, window: f?.window ?? 0, model: f?.model ?? null, effort: f?.effort ?? null, price, warm: warmUsd(price, ctx), cold: coldUsd(price, ctx, ttl) }
  if (!f || f.lastAt <= 0 || ctx <= 0) return { state: 'none', idleMs: 0, leftMs: 0, ...base }
  const idleMs = Math.max(0, now - f.lastAt)
  const leftMs = Math.max(0, TTL_MS[ttl] - idleMs)
  const state: CacheState = leftMs === 0 ? 'cold' : leftMs <= SOON_MS[ttl] ? 'soon' : 'warm'
  return { state, idleMs, leftMs, ...base }
}

const EFFORT_NAME: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' }

/** An effort as people read it: a level by name, a token budget as one. */
export const effortLabel = (effort: string | number | null): string | null =>
  effort == null ? null : typeof effort === 'number' ? `${tok(effort)} budget` : (EFFORT_NAME[effort] ?? effort)

/** The theme key each state is drawn in, so the meter follows the person's theme. */
export const TONE: Record<CacheState, string | undefined> = { none: undefined, warm: 'success', soon: 'warning', cold: 'error' }

/** A usage window's tone: calm under 80% used, a warning to 95%, then an error. */
export const limitTone = (used: number): string | undefined => (used >= 95 ? 'error' : used >= 80 ? 'warning' : undefined)

export const LIMIT_NAME: Record<string, string> = { five_hour: '5-Hour', seven_day: 'Weekly', spend_limit: 'Spend' }
const LIMIT_ORDER: Record<string, number> = { five_hour: 0, seven_day: 1 }

export const sortLimits = <T extends { kind: string }>(list: readonly T[]): T[] =>
  [...list].sort((a, b) => (LIMIT_ORDER[a.kind] ?? 9) - (LIMIT_ORDER[b.kind] ?? 9))

export const resetIn = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  return Number.isNaN(ms) ? '' : ms <= 0 ? 'now' : dur(ms)
}
