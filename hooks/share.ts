// The reading other plugins get from $.vitals: the latest snapshot this session drew. Pure, no engine.

import type { Limit, Vitals, VitalsSnapshot, Stats } from '../types'
import type { CacheView, Ttl } from './cache'
import { pctDown } from './cache'

let latest: VitalsSnapshot | null = null

/** Keeps the newest reading, as the status line refreshes. */
export const setLatest = (s: VitalsSnapshot): void => {
  latest = s
}

/** What `$.vitals` hands other plugins: a read of the latest snapshot, nothing else. */
export const meterApi = (): Vitals => ({ snapshot: async () => latest })

/** The figures a snapshot is made of, as the plugin draws them. */
export type ShareInput = {
  now: number
  ttl: Ttl
  view: CacheView
  who: { label: string; auto: string; id: string; configDir: string; model: string | null; effort: string | null }
  live: { tokens?: number; window: number }
  share: number | null
  autoAt: number | null
  info: { autoOn: boolean | null } | null
  advice: string | null
  ls: readonly Limit[]
  st: Stats
  total: number | null
}

/** The snapshot other plugins read: no e-mail, nothing said in the session. */
export const shareOf = (s: ShareInput, id: string): VitalsSnapshot => {
  const v = s.view
  const inputs = s.st.read + s.st.write + s.st.uncached
  return {
    at: s.now,
    sessionId: id,
    account: { label: s.who.label, auto: s.who.auto, id: s.who.id, configDir: s.who.configDir },
    model: v.state !== 'none' ? v.model : s.who.model,
    effort: v.effort ?? s.who.effort,
    cache: { state: v.state, leftMs: v.leftMs, idleMs: v.idleMs, why: v.why ?? null, ttl: s.ttl, nextUsd: v.state === 'cold' ? v.cold : v.warm, coldUsd: v.cold },
    context: {
      tokens: (v.state !== 'none' ? v.ctx : s.live.tokens) ?? null,
      window: (v.state !== 'none' && v.window) || s.live.window || null,
      percent: s.share,
      autoCompactOn: s.info?.autoOn ?? null,
      autoCompactAtPercent: s.autoAt,
      advice: s.advice,
    },
    limits: s.ls.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt ?? null })),
    session: { requests: s.st.requests, hitPercent: s.st.requests > 0 && inputs > 0 ? pctDown(s.st.read, inputs) : null, usd: s.total },
  }
}
