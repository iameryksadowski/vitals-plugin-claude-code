// When compacting is worth it, from the cache and the context. Pure, no engine.

import type { CacheView } from './cache'
import { pct } from './cache'

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
  return null
}
