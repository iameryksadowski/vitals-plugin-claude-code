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
 * 1.25x input on the 5m TTL and 2x on the 1h TTL. List prices, October 2026.
 * More specific ids first: a model id takes the first row it contains.
 */
export type Price = { name: string; input: number; output: number; read: number }

const PRICES: Array<[string, Price]> = [
  ['fable-5-1', { name: 'Fable 5.1', input: 10, output: 50, read: 0.25 }],
  ['mythos-5-1', { name: 'Mythos 5.1', input: 10, output: 50, read: 0.25 }],
  ['fable-5', { name: 'Fable 5', input: 10, output: 50, read: 1 }],
  ['mythos-5', { name: 'Mythos 5', input: 10, output: 50, read: 1 }],
  ['opus-5-5', { name: 'Opus 5.5', input: 4, output: 20, read: 0.2 }],
  ['opus-5', { name: 'Opus 5', input: 5, output: 25, read: 0.5 }],
  ['opus-4-8', { name: 'Opus 4.8', input: 5, output: 25, read: 0.5 }],
  ['opus-4-7', { name: 'Opus 4.7', input: 5, output: 25, read: 0.5 }],
  ['opus-4-6', { name: 'Opus 4.6', input: 5, output: 25, read: 0.5 }],
  ['opus-4-5', { name: 'Opus 4.5', input: 5, output: 25, read: 0.5 }],
  ['opus-4', { name: 'Opus 4', input: 15, output: 75, read: 1.5 }],
  ['sonnet-5-5', { name: 'Sonnet 5.5', input: 2, output: 10, read: 0.2 }],
  ['sonnet-5', { name: 'Sonnet 5', input: 2, output: 10, read: 0.2 }],
  ['sonnet', { name: 'Sonnet 4', input: 3, output: 15, read: 0.3 }],
  ['haiku-5-5', { name: 'Haiku 5.5', input: 0.1, output: 0.5, read: 0.01 }],
  ['haiku-4-5', { name: 'Haiku 4.5', input: 1, output: 5, read: 0.1 }],
  ['haiku', { name: 'Haiku 3.5', input: 0.8, output: 4, read: 0.08 }],
]

/** Haiku 5.5 prompts over 100k tokens are priced at this row instead. */
const HAIKU_LONG: Price = { name: 'Haiku 5.5', input: 0.5, output: 2.5, read: 0.05 }
const LONG_PROMPT = 100_000

/** The price row for a model id, or null for one this table does not know. */
export const priceOf = (model: string | null | undefined, promptTokens = 0): Price | null => {
  const m = (model ?? '').toLowerCase().replace(/\[.*?\]/g, '').replace(/[\s.@]+/g, '-')
  if (!m) return null
  if (m.includes('haiku-5-5') && promptTokens > LONG_PROMPT) return HAIKU_LONG
  return PRICES.find(([id]) => m.includes(id))?.[1] ?? null
}

export const writeRate = (p: Price, ttl: Ttl): number => p.input * (ttl === '1h' ? 2 : 1.25)

/** What re-sending `ctx` tokens costs while the cache is warm (a read) and once it is cold (a write). */
export const warmUsd = (p: Price | null, ctx: number): number | null => (p ? (ctx * p.read) / 1e6 : null)
export const coldUsd = (p: Price | null, ctx: number, ttl: Ttl): number | null => (p ? (ctx * writeRate(p, ttl)) / 1e6 : null)

/** What one request cost: reads, writes, uncached input and output. */
export const requestUsd = (p: Price | null, r: { read: number; write: number; uncached: number; output: number }, ttl: Ttl): number | null =>
  p ? (r.read * p.read + r.write * writeRate(p, ttl) + r.uncached * p.input + r.output * p.output) / 1e6 : null

export const usd = (n: number | null): string => {
  if (n == null) return 'n/a'
  if (n >= 100) return '$' + n.toFixed(0)
  if (n >= 0.995 || n === 0) return '$' + n.toFixed(2)
  if (n >= 0.01) return '$' + n.toFixed(2)
  return '<$0.01'
}

export const tok = (n: number): string =>
  n >= 1e6 ? `${Number((n / 1e6).toFixed(n >= 1e7 ? 0 : 1))}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n))

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

export const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0)

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
  price: Price | null
  warm: number | null
  cold: number | null
}

/** Everything the band and the pane draw about the cache, at `now`. */
export const viewOf = (
  f: { lastAt: number; ctx: number; window: number; model: string | null } | null,
  now: number,
  ttl: Ttl,
): CacheView => {
  const ctx = f?.ctx ?? 0
  const price = priceOf(f?.model, ctx)
  const base = { ctx, window: f?.window ?? 0, model: f?.model ?? null, price, warm: warmUsd(price, ctx), cold: coldUsd(price, ctx, ttl) }
  if (!f || f.lastAt <= 0 || ctx <= 0) return { state: 'none', idleMs: 0, leftMs: 0, ...base }
  const idleMs = Math.max(0, now - f.lastAt)
  const leftMs = Math.max(0, TTL_MS[ttl] - idleMs)
  const state: CacheState = leftMs === 0 ? 'cold' : leftMs <= SOON_MS[ttl] ? 'soon' : 'warm'
  return { state, idleMs, leftMs, ...base }
}

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
