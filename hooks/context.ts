// When compacting is worth it, from the cache and the context. Pure, no engine.

import type { CacheView } from './cache'
import { pct, tok } from './cache'
import { imagesHeavy } from './images'
import type { ImageWeight } from './images'

/** How close to auto-compact the hint starts, in points of the window. */
export const NEAR_AUTO = 10
/** With auto-compact off, the context share from which the hint starts anyway. */
export const NO_AUTO_AT = 80

export type CompactFacts = {
  /** The context as the engine has it now. */
  context: { tokens?: number; window: number; percent?: number }
  /** Auto-compact: on or off (null unknown), and its threshold in tokens. */
  autoOn: boolean | null
  threshold: number | null
  /** The images in the context, when counted. */
  images?: ImageWeight | null
}

/** The context's share of the window: the cache's own figure first, else the engine's. */
export const sharePct = (view: CacheView, f: CompactFacts): number | null => {
  if (view.state !== 'none' && view.ctx > 0 && view.window > 0) return pct(view.ctx, view.window)
  const { tokens, window, percent } = f.context
  if (tokens && window) return pct(tokens, window)
  return typeof percent === 'number' ? Math.round(percent) : null
}

/** Auto-compact's threshold as a share of the window, or null when it is off or not known. */
export const autoPct = (f: CompactFacts): number | null =>
  f.autoOn === false || !f.threshold || !f.context.window ? null : pct(f.threshold, f.context.window)

/**
 * Why compacting now is a good idea, in a few words, or null. Compacting costs
 * about one full pass over the context: free-ish when the cache is cold anyway
 * (the next message pays that pass regardless), and better at a break of your
 * choosing than when auto-compact cuts in mid-task.
 */
export const adviceOf = (view: CacheView, f: CompactFacts, coldAt: number): string | null => {
  const share = sharePct(view, f)
  if (share == null || share <= 0) return null
  const auto = autoPct(f)
  if (auto != null && share >= auto - NEAR_AUTO) return `auto-compact at ${auto}%`
  if (view.state === 'cold' && view.why !== 'compacted' && share >= coldAt) return `cache cold, context ${share}%`
  if (f.autoOn === false && share >= NO_AUTO_AT) return `context ${share}%, auto-compact off`
  // Images are read again with every message and every Keep Warm ping; /compact images swaps them for text and keeps the rest.
  const ctx = view.state !== 'none' ? view.ctx : (f.context.tokens ?? 0)
  if (imagesHeavy(f.images, ctx)) return `images ${tok(f.images!.tokens)}, /compact images`
  return null
}

/** An id the desktop app gives a claude.ai connector instead of its name. */
const isOpaque = (server: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(server)

const title = (word: string): string => (word.length <= 3 ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1))

/**
 * A server as people can recognise it. The desktop app names claude.ai
 * connectors by an id; their tools usually share a prefix (`notion-search`,
 * `infakt_get_invoice`), which then names the server. Otherwise the commonest
 * prefixes stand in, with the id's first part.
 */
export const mcpLabel = (server: string, tools: readonly string[]): string => {
  const name = server.replace(/^claude\.ai /, '')
  if (!isOpaque(server)) return name
  const counts = new Map<string, number>()
  for (const t of tools) {
    const own = t.startsWith('mcp__') ? t.split('__').slice(2).join('__') : t
    const word = own.split(/[-_]|(?=[A-Z])/)[0]?.toLowerCase()
    if (word && word.length > 1) counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])
  const id = server.slice(0, 8)
  if (top[0] && tools.length > 0 && top[0][1] / tools.length >= 0.6) return title(top[0][0])
  return top.length > 0 ? `${top.slice(0, 3).map(([w]) => w).join(', ')} (${id})` : `Connector ${id}`
}

/** One row of the engine's breakdown, as much of it as the split reads. */
export type BreakdownRow = { name: string; tokens: number; kind?: string; isDeferred?: boolean }

/**
 * The breakdown split as /context means it: what occupies the window, the
 * schemas loaded on demand (outside it), and the reserve auto-compact keeps.
 */
export const splitRows = (rows: readonly BreakdownRow[]): { used: Array<{ name: string; tokens: number }>; deferred: number; buffer: number } => {
  const used: Array<{ name: string; tokens: number }> = []
  let deferred = 0
  let buffer = 0
  for (const r of rows) {
    if (!(r.tokens > 0)) continue
    const kind = r.kind ?? (r.isDeferred || /\(deferred\)/i.test(r.name) ? 'deferred' : /^free space$/i.test(r.name) ? 'free' : /autocompact buffer/i.test(r.name) ? 'buffer' : 'used')
    if (kind === 'deferred') deferred += r.tokens
    else if (kind === 'buffer') buffer += r.tokens
    else if (kind === 'used') used.push({ name: r.name.replace(/\s*\(deferred\)/i, ''), tokens: r.tokens })
  }
  return { used: used.sort((x, y) => y.tokens - x.tokens), deferred, buffer }
}
