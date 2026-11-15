import { atom, read, update } from 'claude-code'
import type { CommandRunInput, EngineInterface, Register, RenderChildren } from 'claude-code'

import { meterApi, setLatest, shareOf } from './share'
import type { AlfredSend, CacheFacts, ContextInfo, EngineCache, KeepWarm, Layout, Limit, PaneTab, RepoPrefs, Stats, TimelineEntry, Who } from '../types'
import { ALFRED_EVERY_MS, alfredBody, homePath } from './alfred'
import { adviceOf, autoPct, mcpLabel, sharePct, splitRows } from './context'
import { WHO_NAME, firstLine, plain, promptEntry, stampOf } from './timeline'
import { SEP, fit, spaced } from './band'
import type { Segment } from './band'
import {
  BAND_DEFAULT, FIELDS, FIELD_INFO, LINE_DEFAULT, MODE_NAME, PRIO, accountOf, fieldsOr, lineOf, loginFileOf, parseFields, piecesOf, suggestLabel,
} from './fields'
import type { Field, LineData, ResetStyle } from './fields'
import {
  COLD_WRITE_MIN, COLD_WRITE_SHARE, GUARD_MIN_TOKENS, LIMIT_NAME, TONE, TTL_MS, WARM_FOR_MS, WARM_LEAD_MS,
  dur, effortLabel, limitTone, modelName, pct, pctDown, priceOf, requestUsd, resetIn, sortLimits, tok, usd, viewOf, warmUsd, writeRate,
} from './cache'
import type { CacheView, Ttl } from './cache'

// A quiet meter above the prompt: whether the prompt cache is warm or cold,
// how long it has left, how big the context is, what the next message costs
// warm and cold, the session's cache hit rate and the usage limits the account
// has. /vitals opens a pane with the full breakdown. Keep Warm, off unless
// switched on, pings the cache with a one-line fork before it expires.

const PANE = 'vitals'
const TITLE = 'Vitals'
/** How often the band redraws, so the countdown and the warm-to-cold flip stay current. */
const TICK_MS = 15_000
const ARGS = '[now|context|cost|timeline|settings] | account [name|reset] | compact | autocompact [on|off] | [warm|guard] [on|off] | [warm|guard] repo [on|off|reset] | [band|line] [show|hide|set|reset] [fields] | line [on|off|auto] | fields'
/** The fork Keep Warm sends: the session's own prefix plus this, so the reply stays one word. */
const PING = 'Cache keep-alive ping from the Vitals plugin. Reply with the single word OK and nothing else.'

const EMPTY_STATS: Stats = { requests: 0, read: 0, write: 0, uncached: 0, output: 0, savedUsd: 0, coldWrites: 0, coldUsd: 0, last: null }
const EMPTY_WARM: KeepWarm = { on: null, since: 0, streak: 0, pings: 0, usd: 0, lastPingAt: 0, missed: 0 }
const EMPTY_ENGINE: EngineCache = { ttl: null, switchedTo: null }

const facts = atom({ plugin: 'vitals', key: 'facts' } as const, null as CacheFacts | null, { shape: 'facts-2' })
const limits = atom({ plugin: 'vitals', key: 'limits' } as const, [] as Limit[], { shape: 'limits-1' })
const stats = atom({ plugin: 'vitals', key: 'stats' } as const, EMPTY_STATS, { shape: 'stats-1' })
const sessionUsd = atom({ plugin: 'vitals', key: 'sessionUsd' } as const, null as number | null, { shape: 'usd-1' })
const warm = atom({ plugin: 'vitals', key: 'warm' } as const, EMPTY_WARM, { shape: 'warm-1' })
const engine = atom({ plugin: 'vitals', key: 'engine' } as const, EMPTY_ENGINE, { shape: 'engine-1' })
/** The cold send guard switched for this session; null follows the setting. */
const holds = atom({ plugin: 'vitals', key: 'guard' } as const, null as boolean | null, { shape: 'guard-1' })
const EMPTY_REPO: RepoPrefs = { root: null, guard: null, warm: null }
const repo = atom({ plugin: 'vitals', key: 'repo' } as const, EMPTY_REPO, { shape: 'repo-1' })
const EMPTY_WHO: Who = { label: '', labelFrom: 'single', id: '', suggested: null, configDir: '', email: null, mode: null, style: null, dir: null, branch: null, effort: null, model: null, tzMin: 0 }
const who = atom({ plugin: 'vitals', key: 'who' } as const, EMPTY_WHO, { shape: 'who-3' })
const EMPTY_LAYOUT: Layout = { band: null, line: null, status: null }
const layout = atom({ plugin: 'vitals', key: 'layout' } as const, EMPTY_LAYOUT, { shape: 'layout-1' })
const EMPTY_ALFRED: AlfredSend = { at: 0, ok: false, status: 0, error: null, sent: 0 }
const alfred = atom({ plugin: 'vitals', key: 'alfred' } as const, EMPTY_ALFRED, { shape: 'alfred-1' })
const compacted = atom({ plugin: 'vitals', key: 'compacted' } as const, false, { shape: 'compacted-1' })
const timeline = atom({ plugin: 'vitals', key: 'timeline' } as const, [] as TimelineEntry[], { shape: 'timeline-2' })
const ctxinfo = atom({ plugin: 'vitals', key: 'ctxinfo' } as const, null as ContextInfo | null, { shape: 'ctxinfo-2' })
/** When the transcript was last written, for a session Vitals joined late (a reload, an install mid-session). */
const resumed = atom({ plugin: 'vitals', key: 'resumed' } as const, null as number | null, { shape: 'resumed-1' })
const tab = atom({ plugin: 'vitals', key: 'tab' } as const, 'now' as PaneTab, { shape: 'tab-1' })
const TABS: ReadonlyArray<{ id: PaneTab; label: string }> = [
  { id: 'now', label: 'Now' }, { id: 'context', label: 'Context' }, { id: 'cost', label: 'Cost' }, { id: 'timeline', label: 'Timeline' }, { id: 'settings', label: 'Settings' },
]
/** Entries the timeline keeps: the newest. */
const TIMELINE_MAX = 80
/** Entries the pane lists, the newest first. */
const TIMELINE_SHOWN = 30
/** How often the /context-style breakdown is read again, at most. */
const CTX_EVERY_MS = 60_000
/** The last request of each recent session, so a session that comes back knows how long the cache has been idle. */
const SESSIONS_KEY = 'sessions'
const SESSIONS_MAX = 40
/** Where /vitals keeps the fields chosen for this account, over the plugin settings. */
const LAYOUT_KEY = 'layout'
/** This account's own label, set with /vitals account or in the pane. */
const ACCOUNT_KEY = 'account'
/** The longest label an account takes. */
const ACCOUNT_MAX = 24
/** The account's last known usage limits, for a new session before its first reply. */
const LIMITS_KEY = 'limits'

/** Plugin settings are read from the user's settings alone, so a repo's own choice is kept in the plugin's store. */
const repoKey = (root: string) => `repo:${root}`
/** A worktree under `.claude/worktrees` keeps the choices of the repo it belongs to. */
const repoRoot = (dir: string) => dir.replace(/\/\.claude\/worktrees\/[^/]+\/?$/, '')
const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

/**
 * The limits the account is actually held to. Plans differ (Ultra has the
 * weekly limit alone), so nothing is assumed: a limit is shown only when the
 * API reports it, and one reported with no reset time and nothing used is idle.
 */
const cleanLimits = (list: readonly Limit[]): Limit[] =>
  sortLimits(
    list
      .filter(w => Number.isFinite(w.percentUsed) && (w.resetsAt !== undefined || w.percentUsed > 0))
      .map(w => ({ kind: w.kind, percentUsed: Math.min(100, Math.max(0, w.percentUsed)), resetsAt: w.resetsAt })),
  )

type TtlOption = Ttl | 'auto'
type GuardMode = 'confirm' | 'warn' | 'off'
/** What register reads from the settings, handed to the top-level helpers. */
type StatusWhere = 'auto' | 'on' | 'off'
type Settings = {
  ttl: TtlOption
  guard: GuardMode
  warmDefault: boolean
  warmForMs: number
  band: Field[]
  line: Field[]
  status: StatusWhere
  reset: ResetStyle
  labels: string
  alfred: { on: boolean; home: string; url: string }
  /** The compact hint: on or off, and the context share from which a cold cache makes it worth it. */
  compact: { on: boolean; coldAt: number }
}
/** What the module keeps between calls in this load: what is pinned and written, Alfred's last send, tools run this turn. */
type Mem = { pinned: string | undefined; written: string | undefined; lineFile: string | null; alfredAt: number; token: string | null; tools: number; compactPending: boolean }
/** Keep Warm's one ping in flight, so ticks never overlap one. */
type PingRun = { busy: boolean }

/**
 * The TTL: the setting when set by hand, else what the engine said it caches
 * with, else a guess: a subscription reports usage limits and caches for an
 * hour, an API key for 5 minutes.
 */
const resolveTtl = (option: TtlOption, ls: readonly Limit[], said: Ttl | null): Ttl =>
  option !== 'auto' ? option : (said ?? (ls.length > 0 ? '1h' : '5m'))

/** Where a switch is set: this session over this repo over the plugin settings. */
type Level = 'session' | 'repo' | 'settings'
const levelOf = (session: boolean | null, inRepo: boolean | null): Level =>
  session !== null ? 'session' : inRepo !== null ? 'repo' : 'settings'
const LEVEL_NAME: Record<Level, string> = { session: 'This session', repo: 'This repo', settings: 'Plugin settings, every repo' }

const isWarmOn = (w: KeepWarm, r: RepoPrefs, cfg: Settings): boolean => w.on ?? r.warm ?? cfg.warmDefault

/** The guard as it runs now: switched on it keeps the setting's way of warning, or holds when the setting is off. */
const guardModeOf = (on: boolean | null, cfg: Settings): GuardMode =>
  on === null ? cfg.guard : on ? (cfg.guard === 'off' ? 'confirm' : cfg.guard) : 'off'

/** The model as people name it, never a raw id where a name can be read. */
const nameOf = (v: CacheView): string => v.price?.name ?? modelName(v.model) ?? v.model ?? 'Unknown model'

/** Everything the band, the pane and the guard read, at one moment. */
async function snapshot($: EngineInterface, cfg: Settings) {
  const ls = await read($, limits)
  const eng = await read($, engine)
  const ttl = resolveTtl(cfg.ttl, ls, eng.ttl)
  const now = await $.clock.now()
  const w = await read($, warm)
  const r = await read($, repo)
  const h = await read($, holds)
  const f = await read($, facts)
  // A model switched to since the last request has no cache of this context:
  // the next message writes all of it, on the new model's price.
  const switched = f && eng.switchedTo && eng.switchedTo !== f.model ? eng.switchedTo : null
  const base = viewOf(switched && f ? { ...f, model: switched } : f, now, ttl)
  let view: CacheView = switched && base.state !== 'none' ? { ...base, state: 'cold', leftMs: 0 } : base
  const st = await read($, stats)
  const me = await read($, who)
  const live = await liveContext($)
  const wasCompacted = await read($, compacted)
  const info = await read($, ctxinfo)
  // After a compaction, or a session that has replied but lost when, the cache holds nothing of this context:
  // it is cold, only how long it has been idle is unknown. Right after a compaction the engine has no live
  // count until the next reply, so the /context estimate stands in.
  const tokens = live.tokens || info?.total || 0
  const since = await read($, resumed)
  if (view.state === 'none' && !wasCompacted && since && tokens) {
    // Vitals joined a session that was already talking: the transcript's last write is when its last request went.
    const model = me.model ?? st.last?.model ?? (await $.session.model().catch(() => null))
    view = viewOf({ lastAt: since, ctx: tokens, window: live.window || info?.window || 0, model, effort: me.effort }, now, ttl)
  }
  if (view.state === 'none' && (wasCompacted || st.requests > 0) && tokens) {
    const model = me.model ?? st.last?.model ?? (await $.session.model().catch(() => null))
    const cold = viewOf({ lastAt: 1, ctx: tokens, window: live.window || info?.window || 0, model, effort: me.effort }, now, ttl)
    view = { ...cold, state: 'cold', idleMs: 0, leftMs: 0, why: wasCompacted ? 'compacted' : 'unknown' }
  }
  const facts4 = { context: live, autoOn: info?.autoOn ?? null, threshold: info?.threshold ?? null }
  return {
    ls, ttl, now, w, view, switched, live, info,
    advice: cfg.compact.on ? adviceOf(view, facts4, cfg.compact.coldAt) : null,
    share: sharePct(view, facts4),
    autoAt: autoPct(facts4),
    st,
    total: await read($, sessionUsd),
    r,
    warmOn: isWarmOn(w, r, cfg),
    warmFrom: levelOf(w.on, r.warm),
    guardMode: guardModeOf(h ?? r.guard, cfg),
    guardFrom: levelOf(h, r.guard),
    who: me,
    layout: await read($, layout),
    sent: await read($, alfred),
  }
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>

/** The live context window as the engine has it; empty where it cannot say. */
async function liveContext($: EngineInterface): Promise<LineData['context']> {
  try {
    return (await $.session.usage()).context
  } catch {
    return { window: 0 }
  }
}

/** The fields the band and the status line show: chosen with /vitals, else the plugin settings. */
const bandFields = (s: Snapshot, cfg: Settings): Field[] => fieldsOr(s.layout.band?.join(','), cfg.band)
const lineFields = (s: Snapshot, cfg: Settings): Field[] => fieldsOr(s.layout.line?.join(','), cfg.line)
const statusWhere = (s: Snapshot, cfg: Settings): StatusWhere => s.layout.status ?? cfg.status

/** Everything a field reads, from one snapshot. */
const lineData = (s: Snapshot, cfg: Settings, context: LineData['context']): LineData => {
  const inputs = s.st.read + s.st.write + s.st.uncached
  return {
    label: s.who.labelFrom === 'single' ? '' : s.who.label,
    email: s.who.email,
    mode: s.who.mode,
    style: s.who.style,
    dir: s.who.dir,
    branch: s.who.branch,
    model: s.view.state !== 'none' ? nameOf(s.view) : (modelName(s.who.model) ?? s.who.model),
    effort: s.view.effort ?? s.who.effort,
    view: s.view,
    switched: s.switched !== null,
    warmOn: s.warmOn,
    requests: s.st.requests,
    hit: s.st.requests > 0 && inputs > 0 ? pctDown(s.st.read, inputs) : null,
    context,
    advice: s.advice,
    limits: s.ls,
    now: s.now,
    total: s.total,
    reset: cfg.reset,
    tzMin: s.who.tzMin,
  }
}

/** A sentence's first letter raised. */
const cap = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text)

/** A folder's last part: `/work/app` is `app`. */
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

/** The git branch checked out in `cwd`, or null outside a repo or a detached head. */
async function branchOf($: EngineInterface, cwd: string): Promise<string | null> {
  try {
    const r = await $.process.run(['git', 'branch', '--show-current'], { cwd, timeoutMs: 3000 })
    return r.exitCode === 0 ? r.stdout.trim() || null : null
  } catch {
    return null
  }
}

/** The account's e-mail and organization from its login record, for showing only. */
async function loginOf($: EngineInterface, configDir: string | undefined, home: string | undefined): Promise<{ email: string | null; organization: string | null }> {
  for (const file of loginFileOf(configDir, home)) {
    try {
      const j = JSON.parse(await $.fs.read(file)) as { oauthAccount?: { emailAddress?: unknown; organizationName?: unknown } }
      const e = j.oauthAccount?.emailAddress
      const o = j.oauthAccount?.organizationName
      if (typeof e === 'string' && e.includes('@')) return { email: e, organization: typeof o === 'string' ? o : null }
    } catch {
      // a missing or unreadable record shows no e-mail
    }
  }
  return { email: null, organization: null }
}

/** Minutes east of UTC, as the host's clock reads them (`date +%z`), for reset times on the clock. */
async function tzOf($: EngineInterface): Promise<number> {
  try {
    const r = await $.process.run(['date', '+%z'], { timeoutMs: 3000 })
    const m = /^([+-])(\d{2})(\d{2})/.exec(r.stdout.trim())
    if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
  } catch {
    // fall back to the module's own clock
  }
  return -new Date().getTimezoneOffset()
}

/** Whether the account's own statusLine command is this plugin's script, which then draws the line in the terminal. */
async function hasLineScript($: EngineInterface): Promise<boolean> {
  try {
    const sl = (await $.settings.read({ key: 'statusLine' })) as { command?: unknown } | undefined
    return typeof sl?.command === 'string' && /vitals|cache-?meter/i.test(sl.command)
  } catch {
    return false
  }
}

/**
 * Draws the status line where it is wanted: written for the account's
 * statusLine script (the terminal), and pinned under the prompt only when
 * asked (`on`), since the band above the prompt already shows it.
 */
async function refreshLine($: EngineInterface, cfg: Settings, mem: Mem): Promise<void> {
  try {
    const s = await snapshot($, cfg)
    setLatest(shareOf(s, await $.session.id()))
    const text = lineOf(lineFields(s, cfg), lineData(s, cfg, await liveContext($)))
    const where = statusWhere(s, cfg)
    // auto: the terminal's statusLine script draws it; the band covers the rest, so nothing is pinned twice.
    const shown = where === 'on' && text ? text : undefined
    if (shown !== mem.pinned) {
      $.ui.status(shown)
      mem.pinned = shown
    }
    if (mem.lineFile && text !== mem.written) {
      await $.fs.write(mem.lineFile, text)
      mem.written = text
    }
  } catch {
    // a status line that fails to draw never holds anything up
  }
}

/**
 * Sends the session's usage windows and context to the local Alfred engine, at
 * most once a minute: the reading its account pills and context pills live on.
 * The e-mail never goes; the token is the engine's local one, from its folder.
 */
async function sendAlfred($: EngineInterface, cfg: Settings, mem: Mem, force = false): Promise<void> {
  if (!cfg.alfred.on) return
  const now = await $.clock.now()
  if (!force && mem.alfredAt && now - mem.alfredAt < ALFRED_EVERY_MS) return
  mem.alfredAt = now
  try {
    const u = await $.session.usage()
    const w = await read($, who)
    const body = alfredBody({ configDir: w.configDir, session: await $.session.id(), model: await $.session.model(), limits: u.rateLimits, context: u.context })
    if (!body) return
    if (mem.token === null) {
      const home = await $.env.get('HOME')
      try {
        mem.token = (await $.fs.read(`${homePath(cfg.alfred.home, home)}/data/api.token`)).trim()
      } catch {
        mem.token = ''
      }
    }
    const bearer = await $.env.get('ALFRED_API_TOKEN')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (mem.token) headers['X-Alfred-Local-Token'] = mem.token
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`
    const url = (await $.env.get('ALFRED_URL')) || cfg.alfred.url
    const r = await $.http.fetch(`${url.replace(/\/+$/, '')}/api/konta/uzycie`, { method: 'POST', headers, body: JSON.stringify(body) })
    await update($, alfred, a => ({ at: now, ok: r.ok, status: r.status, error: r.ok ? null : r.text.slice(0, 200), sent: a.sent + (r.ok ? 1 : 0) }))
  } catch (err) {
    await update($, alfred, a => ({ ...a, at: now, ok: false, status: 0, error: String(err instanceof Error ? err.message : err).slice(0, 200) }))
  }
}

/** Keeps the fields chosen with /vitals for this account and every session after. */
async function setLayout($: EngineInterface, change: (l: Layout) => Layout): Promise<Layout> {
  let next = EMPTY_LAYOUT
  await update($, layout, l => (next = change(l)))
  if (next.band === null && next.line === null && next.status === null) await $.store.delete(LAYOUT_KEY)
  else await $.store.set(LAYOUT_KEY, next)
  $.ui.invalidate('ui.render')
  return next
}

async function openPane($: EngineInterface, to?: PaneTab) {
  if (to) await update($, tab, () => to)
  return $.ui.open({ id: PANE, title: TITLE })
}

/** Reads the context as /context counts it (estimated locally, no request), at most once a minute unless forced. */
async function refreshContext($: EngineInterface, force = false): Promise<void> {
  try {
    const now = await $.clock.now()
    const had = await read($, ctxinfo)
    if (!force && had && now - had.at < CTX_EVERY_MS) return
    const u = await $.session.usage({ breakdown: 'summary' })
    const b = u.context.breakdown
    if (!b) return
    const byServer = new Map<string, { tokens: number; deferred: number; tools: string[] }>()
    for (const t of b.mcpTools ?? []) {
      const s = byServer.get(t.serverName) ?? { tokens: 0, deferred: 0, tools: [] }
      if (t.isLoaded === false) s.deferred += t.tokens
      else s.tokens += t.tokens
      s.tools.push(t.name)
      byServer.set(t.serverName, s)
    }
    const rows = splitRows(b.categories)
    const info: ContextInfo = {
      at: now,
      total: b.totalTokens,
      autoOn: b.isAutoCompactEnabled,
      threshold: b.isAutoCompactEnabled ? (b.autoCompactThreshold ?? null) : null,
      window: b.maxTokens || u.context.window,
      categories: rows.used,
      deferred: rows.deferred,
      buffer: rows.buffer,
      mcp: [...byServer]
        .map(([server, s]) => ({ server, label: mcpLabel(server, s.tools), tokens: s.tokens, deferred: s.deferred }))
        .sort((x, y) => y.tokens - x.tokens || y.deferred - x.deferred)
        .slice(0, 6),
    }
    await update($, ctxinfo, () => info)
  } catch {
    // no breakdown: the hint falls back to the context share alone
  }
}

/** Adds one moment to the timeline, the newest kept. */
async function remember($: EngineInterface, entry: TimelineEntry): Promise<void> {
  await update($, timeline, list => [...list, entry].slice(-TIMELINE_MAX))
}


/** Keeps when this session's last request started and how big it was, for when the session comes back. */
async function keepLast($: EngineInterface, f: CacheFacts): Promise<void> {
  try {
    const id = await $.session.id()
    const all = ((await $.store.get(SESSIONS_KEY)) ?? {}) as Record<string, CacheFacts>
    all[id] = f
    const kept = Object.entries(all).sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, SESSIONS_MAX)
    await $.store.set(SESSIONS_KEY, Object.fromEntries(kept))
  } catch {
    // a session that comes back without it reads its cache as cold
  }
}

/** The facts a returning session left behind, if any. */
async function lastOf($: EngineInterface): Promise<CacheFacts | null> {
  try {
    const all = (await $.store.get(SESSIONS_KEY)) as Record<string, CacheFacts> | undefined
    const f = all?.[await $.session.id()]
    return f && typeof f.lastAt === 'number' && f.lastAt > 0 && typeof f.ctx === 'number' ? f : null
  } catch {
    return null
  }
}

/**
 * Compacts now, the same call /compact makes; says how it went. The engine skips
 * this plugin's own session.compact hook for its own call, so the reset is here.
 */
async function compactNow($: EngineInterface, mem?: Mem): Promise<string> {
  if (mem) mem.compactPending = false
  try {
    const r = await $.session.compact()
    if ('skip' in r && r.skip) return `Not compacted: ${r.skip}`
    await update($, facts, () => null)
    await update($, compacted, () => true)
    await refreshContext($, true)
    $.ui.invalidate('ui.render')
    return 'Compacted.'
  } catch (err) {
    return `Not compacted: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`
  }
}

/** Switches Claude Code's own auto-compact, as /config does; `to` left out flips it. */
async function setAutoCompact($: EngineInterface, to?: boolean): Promise<string> {
  await refreshContext($, true)
  const was = (await read($, ctxinfo))?.autoOn ?? null
  const value = to ?? !(was ?? true)
  try {
    const r = await $.config.set({ key: 'autoCompact', value })
    if ('deny' in r && r.deny) return `Auto-compact stays ${was === false ? 'off' : 'on'}: ${r.deny}`
  } catch (err) {
    return `Auto-compact not changed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`
  }
  await refreshContext($, true)
  $.ui.invalidate('ui.render')
  return `Auto-compact is ${value ? 'on' : 'off'}.`
}

/** Switches Keep Warm for this session; `to` left out flips it. */
async function setKeepWarm($: EngineInterface, cfg: Settings, to?: boolean): Promise<boolean> {
  const now = await $.clock.now()
  const r = await read($, repo)
  let isOn = false
  await update($, warm, w => {
    isOn = to ?? !isWarmOn(w, r, cfg)
    // Switching on counts the window from now, so it never pings for a message long gone.
    return { ...w, on: isOn, since: isOn ? Math.max(w.since, now) : w.since, streak: isOn ? 0 : w.streak }
  })
  $.ui.invalidate('ui.render')
  return isOn
}

/** Switches the cold send guard for this session; `to` left out flips it. */
async function setGuard($: EngineInterface, cfg: Settings, to?: boolean): Promise<boolean> {
  const r = await read($, repo)
  let isOn = false
  await update($, holds, h => {
    isOn = to ?? guardModeOf(h ?? r.guard, cfg) === 'off'
    return isOn
  })
  $.ui.invalidate('ui.render')
  return isOn
}

/**
 * Keeps a switch for every session in this repo (`to` true or false), or
 * hands it back to the plugin settings (null). It takes over in this session
 * too. Resolves the repo's folder, or null when the session has none.
 */
async function setRepo($: EngineInterface, field: 'guard' | 'warm', to: boolean | null): Promise<string | null> {
  const r = await read($, repo)
  if (!r.root) return null
  const now = await $.clock.now()
  const next: RepoPrefs = { ...r, [field]: to }
  await update($, repo, () => next)
  const kept = { ...(next.guard !== null ? { guard: next.guard } : {}), ...(next.warm !== null ? { warm: next.warm } : {}) }
  if (Object.keys(kept).length > 0) await $.store.set(repoKey(r.root), kept)
  else await $.store.delete(repoKey(r.root))
  if (field === 'guard') await update($, holds, () => null)
  else await update($, warm, w => ({ ...w, on: null, since: to ? Math.max(w.since, now) : w.since, streak: to ? 0 : w.streak }))
  $.ui.invalidate('ui.render')
  return r.root
}

/**
 * One Keep Warm check: shortly before the cache would expire, and while the
 * last real message is recent enough, fork one tool-less question over the
 * session's own transcript on its own model. The API serves that prefix from
 * the cache and the read starts the TTL over. A ping that finds the cache
 * already gone paid a full write, so Keep Warm switches itself off.
 */
async function keepWarmTick($: EngineInterface, cfg: Settings, run: PingRun): Promise<void> {
  if (run.busy) return
  const { view, ttl, now, w, warmOn, switched } = await snapshot($, cfg)
  if (!warmOn || switched || (view.state !== 'warm' && view.state !== 'soon')) return
  if (view.leftMs > WARM_LEAD_MS[ttl] || now - w.since > cfg.warmForMs) return
  run.busy = true
  try {
    const r = await $.model.fork({ prompt: PING })
    if (!('usage' in r)) return
    const u = r.usage
    const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    if (prompt === 0) return
    const cost = requestUsd(
      priceOf(view.model, prompt),
      { read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, uncached: u.input_tokens, output: u.output_tokens },
      ttl,
    )
    const isHit = u.cache_read_input_tokens >= COLD_WRITE_SHARE * prompt
    if (isHit) await update($, facts, f => (f ? { ...f, lastAt: now } : f))
    await update($, warm, s => ({
      ...s,
      on: isHit ? s.on : false,
      streak: s.streak + 1,
      pings: s.pings + 1,
      usd: s.usd + (cost ?? 0),
      lastPingAt: now,
      missed: s.missed + (isHit ? 0 : 1),
    }))
    if (!isHit) $.ui.toast('Vitals: Keep Warm found the cache already expired and switched itself off.')
  } finally {
    run.busy = false
    $.ui.invalidate('ui.render')
  }
}

/** The account and place the session runs in, read once a session and kept fresh by the events below. */
/**
 * Whether this machine runs more than one Claude Code account: a config folder
 * other than ~/.claude, or another ~/.claude-* folder next to it. With one
 * account the band and the line leave its name out.
 */
async function hasOtherAccounts($: EngineInterface, configDir: string, home: string | undefined): Promise<boolean> {
  const h = (home ?? '').replace(/\/+$/, '')
  if (configDir && configDir.replace(/\/+$/, '') !== `${h}/.claude`) return true
  try {
    return (await $.fs.list(h)).some(x => x.kind === 'dir' && /^\.claude[-_][A-Za-z0-9]+$/.test(x.name))
  } catch {
    return false
  }
}

/** Labels this account, or hands the label back to its folder. */
async function setAccountName($: EngineInterface, cfg: Settings, name: string | null): Promise<string> {
  if (name) await $.store.set(ACCOUNT_KEY, { label: name })
  else await $.store.delete(ACCOUNT_KEY)
  await loadWho($, cfg, '')
  const w = await read($, who)
  $.ui.invalidate('ui.render')
  return name ? `This account (${w.id}) is now ${w.label}, in every session on it.` : `This account (${w.id}) is ${w.label} again: ${LABEL_FROM[w.labelFrom]}.`
}

/** Where the label comes from, as the pane and /vitals account say it. */
const LABEL_FROM: Record<Who['labelFrom'], string> = {
  own: 'your own name for it',
  setting: 'from accountLabels in the plugin settings',
  folder: 'the name in its config folder',
  letter: 'a letter, as its config folder carries no name',
  single: 'the only account here, so the band leaves it out',
}

/** `/vitals account` with nothing after it: the label, where it comes from, the id, and how to change it. */
const accountText = (w: Who): string =>
  [
    `Label  ${w.label || '(none)'}: ${LABEL_FROM[w.labelFrom]}`,
    `ID     ${w.id} (the account's config folder, ${w.configDir || '~/.claude'})`,
    ...(w.suggested && (w.labelFrom === 'letter' || w.labelFrom === 'single') ? [`Idea   /vitals account ${w.suggested}`] : []),
    '/vitals account <name> labels it (Work, Personal, anything up to 24 characters); /vitals account reset hands it back.',
  ].join('\n')

/**
 * When the session's transcript was last written: for a session Vitals joined
 * late, the time its last request went. Claude Code keeps it under the
 * account's config folder, in a folder named after the session's directory.
 */
async function transcriptAt($: EngineInterface, cwd: string): Promise<number | null> {
  try {
    const home = ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
    const dir = ((await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`).replace(/\/+$/, '')
    const id = await $.session.id()
    const where = cwd || (await $.session.cwd())
    const at = await $.fs.stat(`${dir}/projects/${where.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`).catch(() => null)
    return at && at.size > 0 && at.mtimeMs > 0 ? at.mtimeMs : null
  } catch {
    return null
  }
}

async function loadWho($: EngineInterface, cfg: Settings, cwd: string): Promise<void> {
  try {
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? ''
    const home = await $.env.get('HOME')
    const own = ((await $.store.get(ACCOUNT_KEY).catch(() => undefined)) as { label?: unknown } | undefined)?.label
    const acct = accountOf(configDir, home, cfg.labels, own)
    const labelFrom: Who['labelFrom'] = acct.from === 'letter' && !(await hasOtherAccounts($, configDir, home)) ? 'single' : acct.from
    const login = await loginOf($, configDir, home)
    const idea = suggestLabel(login.email, login.organization)
    const effort = await $.settings.read({ key: 'effortLevel' }).catch(() => undefined)
    const where = cwd || (await $.session.cwd())
    const next: Who = {
      label: acct.label,
      labelFrom,
      id: acct.id,
      // Offered only where it would say more than the letter does.
      suggested: idea && idea.toLowerCase() !== acct.label.toLowerCase() ? idea : null,
      configDir,
      email: login.email,
      mode: null,
      style: null,
      dir: baseName(where),
      branch: await branchOf($, where),
      effort: typeof effort === 'string' ? effort : null,
      model: await $.session.model().catch(() => null),
      tzMin: await tzOf($),
    }
    await update($, who, w => ({ ...next, mode: w.mode, style: w.style }))
  } catch {
    // the account fields stay empty rather than hold up the session
  }
}

/** Keeps the permission mode a classic hook input carries. */
async function seeMode($: EngineInterface, cfg: Settings, mem: Mem, mode: unknown): Promise<void> {
  if (typeof mode === 'string' && mode && (await read($, who)).mode !== mode) {
    await update($, who, w => ({ ...w, mode }))
    void refreshLine($, cfg, mem)
  }
}

/** Every field, and where each list stands now: for `/vitals fields`. */
async function fieldsText($: EngineInterface, cfg: Settings): Promise<string> {
  const s = await snapshot($, cfg)
  const band = bandFields(s, cfg)
  const line = lineFields(s, cfg)
  return [
    `Band:        ${band.join(', ')}${s.layout.band ? ' (set with /vitals)' : ''}`,
    `Status line: ${line.join(', ')}${s.layout.line ? ' (set with /vitals)' : ''}, pinned ${statusWhere(s, cfg)}`,
    '',
    ...FIELDS.map(f => `${f.padEnd(9)}${FIELD_INFO[f]}`),
    '',
    '/vitals band|line show|hide <fields>, /vitals band|line set <fields in order>, /vitals band|line reset, /vitals line on|off|auto.',
  ].join('\n')
}

/** `/vitals band ...` and `/vitals line ...`: shows, hides, orders or resets the fields, or pins the line. */
async function layoutCommand($: EngineInterface, cfg: Settings, mem: Mem, which: 'band' | 'line', verb: string, rest: string): Promise<string> {
  const name = which === 'band' ? 'The band' : 'The status line'
  const current = () => snapshot($, cfg).then(s => (which === 'band' ? bandFields(s, cfg) : lineFields(s, cfg)))
  if (which === 'line' && (verb === 'on' || verb === 'off' || verb === 'auto')) {
    await setLayout($, l => ({ ...l, status: verb === 'auto' && cfg.status === 'auto' ? null : verb }))
    await refreshLine($, cfg, mem)
    return verb === 'on'
      ? 'The status line is pinned under the prompt in every session of this account.'
      : verb === 'off'
        ? 'The status line is no longer pinned under the prompt (a terminal statusLine script still draws it).'
        : 'The status line is pinned wherever no terminal statusLine script draws it, the desktop app among them.'
  }
  if (verb === 'reset') {
    await setLayout($, l => (which === 'band' ? { ...l, band: null } : { ...l, line: null }))
    await refreshLine($, cfg, mem)
    return `${name} follows the plugin settings again: ${(await current()).join(', ')}.`
  }
  if (verb === 'show' || verb === 'hide' || verb === 'set') {
    const { fields, unknown } = parseFields(rest)
    if (fields.length === 0) return `Name the fields to ${verb}: ${FIELDS.join(', ')}.${unknown.length ? ` Not a field: ${unknown.join(', ')}.` : ''}`
    const now = await current()
    const next =
      verb === 'set' ? fields : verb === 'show' ? [...now, ...fields.filter(f => !now.includes(f))] : now.filter(f => !fields.includes(f))
    await setLayout($, l => (which === 'band' ? { ...l, band: next } : { ...l, line: next }))
    await refreshLine($, cfg, mem)
    return `${name} shows: ${next.length ? next.join(', ') : 'nothing'}.${unknown.length ? ` Not a field: ${unknown.join(', ')}.` : ''}`
  }
  const s = await snapshot($, cfg)
  const text = which === 'line' ? lineOf(lineFields(s, cfg), lineData(s, cfg, await liveContext($))) : ''
  return [
    `${name} shows: ${(await current()).join(', ')}.`,
    ...(which === 'line' ? [`Now: ${text || '(nothing to show yet)'}`, `Pinned under the prompt: ${statusWhere(s, cfg)}.`] : []),
    `/vitals ${which} show|hide|set <fields>, /vitals ${which} reset${which === 'line' ? ', /vitals line on|off|auto' : ''}; /vitals fields lists them all.`,
  ].join('\n')
}

/** `/vitals`: the pane, a tab of it, or one of the switches. */
async function answerCommand($: EngineInterface, e: CommandRunInput, cfg: Settings, mem: Mem) {
  const [sub, arg, arg2] = (e.args ?? '').trim().toLowerCase().split(/\s+/)
  if (sub === 'fields') return { text: await fieldsText($, cfg) }
  if (sub === 'account') {
    const raw = (e.args ?? '').trim().split(/\s+/).slice(1).join(' ').trim()
    if (!raw) {
      const w = await read($, who)
      return { text: accountText(w) }
    }
    const text = await setAccountName($, cfg, raw.toLowerCase() === 'reset' ? null : raw.slice(0, ACCOUNT_MAX))
    void refreshLine($, cfg, mem)
    return { text }
  }
  if (sub === 'compact') {
    // A command holds its turn, and compacting under it is refused: it runs right after, or at the turn's end.
    mem.compactPending = true
    try {
      $.clock.after(300, () => {
        if (mem.compactPending) void compactNow($, mem).then(t => $.ui.toast(t))
      })
    } catch {
      // no timer here: the end of the turn runs it
    }
    return { text: 'Compacting as soon as this command is done.' }
  }
  if (sub === 'autocompact') return { text: await setAutoCompact($, arg === 'on' ? true : arg === 'off' ? false : undefined) }
  const toTab = TABS.find(t => t.id === sub)?.id
  if (toTab) {
    const opened = await openPane($, toTab)
    if (opened.isPlaced) return { text: `${TABS.find(t => t.id === toTab)!.label} is open in the side pane.` }
  }
  if (sub === 'band' || sub === 'line') {
    const rest = (e.args ?? '').trim().split(/\s+/).slice(2).join(' ')
    return { text: await layoutCommand($, cfg, mem, sub, arg ?? '', rest) }
  }
  if ((sub === 'warm' || sub === 'guard') && arg === 'repo') {
    const name = sub === 'warm' ? 'Keep Warm' : 'The cold send guard'
    const to = arg2 === 'on' ? true : arg2 === 'off' ? false : arg2 === 'reset' ? null : undefined
    if (to === undefined) {
      const s = await snapshot($, cfg)
      const isOn = sub === 'warm' ? s.warmOn : s.guardMode !== 'off'
      const kept = sub === 'warm' ? s.r.warm : s.r.guard
      return { text: `${name} is ${isOn ? 'on' : 'off'} here. This repo ${kept === null ? 'follows the plugin settings' : `keeps it ${kept ? 'on' : 'off'}`}. /vitals ${sub} repo on, off or reset changes that.` }
    }
    const root = await setRepo($, sub, to)
    if (!root) return { text: 'This session has no repo folder to keep it for.' }
    if (to !== null) return { text: `${name} is ${to ? 'on' : 'off'} in every session in ${root}.` }
    const s = await snapshot($, cfg)
    const isOn = sub === 'warm' ? s.warmOn : s.guardMode !== 'off'
    return { text: `${root} follows the plugin settings again: ${name} is ${isOn ? 'on' : 'off'}.` }
  }
  if (sub === 'warm') {
    const isOn = await setKeepWarm($, cfg, arg === 'on' ? true : arg === 'off' ? false : undefined)
    return { text: `Keep Warm is ${isOn ? 'on' : 'off'} for this session.` }
  }
  if (sub === 'guard') {
    const isOn = await setGuard($, cfg, arg === 'on' ? true : arg === 'off' ? false : undefined)
    return { text: `The cold send guard is ${isOn ? 'on' : 'off'} for this session.` }
  }
  const opened = await openPane($)
  if (opened.isPlaced) return { text: 'Vitals is open in the side pane.' }
  const s = await snapshot($, cfg)
  const line = lineOf(lineFields(s, cfg), lineData(s, cfg, await liveContext($)))
  const auto = s.info?.autoOn === false ? 'off' : s.autoAt != null ? `at ${s.autoAt}%` : 'on'
  return {
    text: [
      `${'Status Line'.padEnd(14)}${line || 'Nothing to show yet'}`,
      ...summary(s.view, s.st, s.ls, s.ttl, s.now, s.total, s.warmOn, s.w, s.switched, s.guardMode, s.warmFrom, s.guardFrom),
      `${'Auto-Compact'.padEnd(14)}${auto}${s.advice ? `. Compact now: ${s.advice} (/vitals compact)` : ''}`,
    ].join('\n'),
  }
}

export const register: Register = (on, options) => {
  // Other plugins read this session's figures from $.vitals (see types/index.d.ts).
  on('engine.create', async ($, e, next) => {
    const beneath: Omit<EngineInterface, 'vitals'> = await next(e)
    return { ...beneath, vitals: meterApi() }
  })

  const cfg: Settings = {
    ttl: options.ttl === '1h' || options.ttl === '5m' ? options.ttl : 'auto',
    // Both off unless switched on: in the settings for every project, a project's own settings, or per session.
    guard: options.guard === 'confirm' || options.guard === 'warn' ? options.guard : 'off',
    warmDefault: options.keepWarm === 'on',
    warmForMs: WARM_FOR_MS[String(options.keepWarmFor)] ?? WARM_FOR_MS['2h']!,
    band: fieldsOr(options.bandFields, BAND_DEFAULT),
    line: fieldsOr(options.lineFields, LINE_DEFAULT),
    status: options.statusLine === 'on' || options.statusLine === 'off' ? options.statusLine : 'auto',
    reset: options.resetStyle === 'countdown' || options.resetStyle === 'clock' || options.resetStyle === 'both' ? options.resetStyle : 'auto',
    labels: typeof options.accountLabels === 'string' ? options.accountLabels : '',
    alfred: {
      on: options.alfred === 'on',
      home: typeof options.alfredHome === 'string' && options.alfredHome.trim() ? options.alfredHome.trim() : '~/Development/alfred-app',
      url: typeof options.alfredUrl === 'string' && /^https?:\/\//.test(options.alfredUrl.trim()) ? options.alfredUrl.trim() : 'http://127.0.0.1:8765',
    },
    compact: {
      on: options.compactHint !== 'off',
      coldAt: [30, 40, 50, 60, 70].includes(Number(options.compactAt)) ? Number(options.compactAt) : 50,
    },
  }
  const run: PingRun = { busy: false }
  const mem: Mem = { pinned: undefined, written: undefined, lineFile: null, alfredAt: 0, token: null, tools: 0, compactPending: false }
  /** The cold send the person was already told about: its resend goes through. */
  let ackedAt = 0

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const u = await $.session.usage()
    // Before the first reply of a restart the API has reported no limits yet: the last known ones stay
    // (a passed reset reads as such), so a subscription is never mistaken for an API key and its 1h TTL kept.
    const fresh = cleanLimits(u.rateLimits)
    if (fresh.length > 0) await update($, limits, () => fresh)
    else if ((await read($, limits)).length === 0) {
      // A new session shows the account's last known limits until its first reply brings fresh ones.
      const known = (await $.store.get(LIMITS_KEY).catch(() => undefined)) as Limit[] | undefined
      if (Array.isArray(known)) await update($, limits, () => cleanLimits(known))
    }
    await update($, sessionUsd, () => u.cost?.usd ?? null)
    // A session that comes back (a restart of the app) knows when its last request started.
    if (!(await read($, facts))) {
      const kept = await lastOf($)
      if (kept) await update($, facts, () => kept)
      else {
        const at = await transcriptAt($, e.cwd)
        await update($, resumed, () => at)
      }
    }
    void refreshContext($, true)
    const root = repoRoot(await $.session.root())
    const kept = (await $.store.get(repoKey(root))) as { guard?: unknown; warm?: unknown } | undefined
    await update($, repo, () => ({ root, guard: flag(kept?.guard), warm: flag(kept?.warm) }))
    await loadWho($, cfg, e.cwd)
    const stored = (await $.store.get(LAYOUT_KEY).catch(() => undefined)) as Partial<Layout> | undefined
    await update($, layout, () => ({
      band: Array.isArray(stored?.band) ? parseFields(stored.band.join(',')).fields : null,
      line: Array.isArray(stored?.line) ? parseFields(stored.line.join(',')).fields : null,
      status: stored?.status === 'auto' || stored?.status === 'on' || stored?.status === 'off' ? stored.status : null,
    }))
    if (await hasLineScript($)) {
      const tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
      mem.lineFile = `${tmp}/vitals/${await $.session.id()}.line`
    }
    await $.command.register({
      name: 'vitals',
      description: 'Vitals: prompt cache, context and compaction, usage limits, account, timeline; Keep Warm, the cold send guard and which fields show',
      argumentHint: ARGS,
    })
    $.clock.every(TICK_MS, () => {
      $.ui.invalidate('ui.render')
      void keepWarmTick($, cfg, run)
      void refreshLine($, cfg, mem)
    })
    await refreshLine($, cfg, mem)
    void sendAlfred($, cfg, mem, true)
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      const fresh = cleanLimits(e.rateLimits)
      await update($, limits, () => fresh)
      if (fresh.length > 0) await $.store.set(LIMITS_KEY, fresh).catch(() => undefined)
    }
    if (e.changed.includes('cost') && e.cost) {
      const total = e.cost.usd
      await update($, sessionUsd, () => total)
    }
    if (e.changed.includes('context') && e.context.window) {
      const window = e.context.window
      await update($, facts, f => (f ? { ...f, window } : f))
    }
    void sendAlfred($, cfg, mem, e.changed.includes('rateLimits'))
    void refreshLine($, cfg, mem)
    return next(e)
  })

  // The permission mode rides on every classic hook input: the latest one wins.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await seeMode($, cfg, mem, e.permission_mode)
    mem.tools = 0
    const entry = promptEntry(e.prompt, e.source, await $.clock.now())
    if (entry) await remember($, entry)
    return next(e)
  }).catch(($, e, next) => next(e)) // reading the mode never holds up a prompt
  on('classic.Stop', async ($, e, next) => {
    await seeMode($, cfg, mem, e.permission_mode)
    return next(e)
  }).catch(($, e, next) => next(e)) // nor the end of a turn

  // The output style is a fact of the system prompt the engine composes.
  on('prompt.compose', async ($, e, next) => {
    const style = e.outputStyle?.name ?? null
    if ((await read($, who)).style !== style) await update($, who, w => ({ ...w, style }))
    return next(e)
  }).catch(($, e, next) => next(e)) // nor a request

  // /clear and compaction start a new prefix; a resume or fork knows how long it was away and how big it is.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    ackedAt = 0
    if (e.source === 'clear') {
      await update($, facts, () => null)
      await update($, compacted, () => false)
      await update($, timeline, () => [])
      await update($, stats, () => EMPTY_STATS)
      await update($, resumed, () => null)
      await update($, engine, g => ({ ...g, switchedTo: null }))
    } else if (e.source === 'compact') {
      await update($, facts, () => null)
      await update($, compacted, () => true)
      await update($, engine, g => ({ ...g, switchedTo: null }))
      await update($, resumed, () => null)
    } else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const now = await $.clock.now()
      const u = await $.session.usage()
      const lastAt = now - e.seconds_since_last_response * 1000
      const ctx = typeof e.context_tokens === 'number' ? e.context_tokens : (u.context.tokens ?? 0)
      const model = typeof e.model === 'string' ? e.model : await $.session.model()
      await update($, facts, f => ({ lastAt, ctx, window: u.context.window, model, effort: f?.effort ?? null }))
      await update($, engine, g => ({ ...g, switchedTo: null }))
      await update($, warm, w => ({ ...w, since: lastAt, streak: 0 }))
    }
    return r
  }).catch(($, e, next) => next(e)) // a meter that fails to seed never holds up the session

  // The engine says which TTL it caches with, and that a new model starts with no cache.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const r = await next(e)
    const ttl = e.cache_ttl === '5m' || e.cache_ttl === '1h' ? e.cache_ttl : null
    const to = e.to_model !== e.from_model ? e.to_model : null
    await update($, engine, g => ({ ttl: ttl ?? g.ttl, switchedTo: to ?? g.switchedTo }))
    $.ui.invalidate('ui.render')
    return r
  }).catch(($, e, next) => next(e)) // a meter that fails never holds up a model switch

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    // The summary is the next request's whole prefix: writing it is no cold write.
    if (!e.agentId && !('skip' in r && r.skip)) {
      await update($, facts, () => null)
      await update($, compacted, () => true)
      void refreshContext($, true)
    }
    return r
  }).catch(($, e, next) => next(e)) // a failed reset never holds up a compaction

  // Each main-thread request reads or writes the cache, and its start resets the TTL.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId || run.busy) return yield* next(e)
    const startedAt = await $.clock.now()
    const r = yield* next(e)
    const u = r.usage
    if (!u) return r
    const model = u.model || e.model
    const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    const price = priceOf(model, prompt)
    const ttl = resolveTtl(cfg.ttl, await read($, limits), (await read($, engine)).ttl)
    const prev = (await read($, facts))?.ctx ?? 0
    const write = u.cache_creation_input_tokens
    const isColdWrite = prev >= COLD_WRITE_MIN && write >= COLD_WRITE_SHARE * prev
    const req = { read: u.cache_read_input_tokens, write, uncached: u.input_tokens, output: u.output_tokens }
    const cost = requestUsd(price, req, ttl)
    await update($, stats, s => ({
      requests: s.requests + 1,
      read: s.read + req.read,
      write: s.write + req.write,
      uncached: s.uncached + req.uncached,
      output: s.output + req.output,
      savedUsd: s.savedUsd + (price ? (req.read * (price.input - price.read)) / 1e6 : 0),
      coldWrites: s.coldWrites + (isColdWrite ? 1 : 0),
      coldUsd: s.coldUsd + (isColdWrite && price ? (write * writeRate(price, ttl)) / 1e6 : 0),
      last: { at: startedAt, ...req, model, usd: cost },
    }))
    // The next request re-sends this prompt and this answer, on this model.
    const known = (await read($, facts))?.window
    const window = known || (await $.session.usage()).context.window || 0
    const kept: CacheFacts = { lastAt: startedAt, ctx: prompt + u.output_tokens, window, model, effort: e.effort ?? null }
    await update($, facts, () => kept)
    await update($, compacted, () => false)
    void keepLast($, kept)
    await update($, engine, g => (g.switchedTo ? { ...g, switchedTo: null } : g))
    await update($, warm, w => ({ ...w, since: startedAt, streak: 0 }))
    return r
  })

  // Tools the main thread ran this turn, for the timeline.
  on('tool.call', async ($, e, next) => {
    if (!(e as { agentId?: string }).agentId) mem.tools += 1
    return next(e)
  }).catch(($, e, next) => next(e)) // counting never holds up a tool

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const said = firstLine(typeof e.answer === 'string' && e.answer ? e.answer : typeof r?.text === 'string' ? r.text : '')
    await remember($, { at: await $.clock.now(), who: 'claude', text: e.isAborted ? 'Stopped' : said || null, ms: e.durationMs, tools: mem.tools })
    if (mem.compactPending) $.ui.toast(await compactNow($, mem))
    void refreshContext($)
    const u = await $.session.usage()
    if (u.context.window) {
      const window = u.context.window
      await update($, facts, f => (f && !f.window ? { ...f, window } : f))
    }
    const s = await snapshot($, cfg)
    if ([...bandFields(s, cfg), ...lineFields(s, cfg)].includes('branch')) {
      const cwd = await $.session.cwd()
      const branch = await branchOf($, cwd)
      await update($, who, w => ({ ...w, dir: baseName(cwd), branch }))
    }
    const model = await $.session.model().catch(() => null)
    if (model) await update($, who, w => (w.model === model ? w : { ...w, model }))
    void sendAlfred($, cfg, mem)
    void refreshLine($, cfg, mem)
    return r
  })

  // A message sent into a cold cache re-writes the whole context. Held once, with the price; the resend goes through.
  on('prompt.submit', async ($, e, next) => {
    const guard = guardModeOf((await read($, holds)) ?? (await read($, repo)).guard, cfg)
    if (guard === 'off') return next(e)
    const kind = e.origin?.kind
    if (kind && kind !== 'composer' && kind !== 'bridge') return next(e)
    if (e.command || e.text.trimStart().startsWith('/')) return next(e)
    const f = await read($, facts)
    const { view, ttl, switched } = await snapshot($, cfg)
    if (!f || view.state !== 'cold' || view.ctx < GUARD_MIN_TOKENS) return next(e)
    const why = switched
      ? `The model changed to ${nameOf(view)}, so the prompt cache starts empty.`
      : `The prompt cache went cold ${dur(view.idleMs - TTL_MS[ttl])} ago.`
    const price = view.cold != null ? ` for ${usd(view.cold)}${view.warm != null && !switched ? ` (a warm read would be ${usd(view.warm)})` : ''}` : ''
    const text = `Vitals: ${why} This message re-writes ~${tok(view.ctx)} tokens on ${nameOf(view)}${price}.`
    if (guard === 'warn' || ackedAt === f.lastAt) {
      if (guard === 'warn') $.ui.log(text)
      ackedAt = 0
      return next(e)
    }
    ackedAt = f.lastAt
    return { drop: `${text} Send it again to go ahead, or /clear and start from a short summary. /vitals guard off stops these holds.` }
  }).catch(($, e, next) => next(e)) // a meter that fails never blocks a message

  on('command.run', { command: 'vitals' }, ($, e) => answerCommand($, e, cfg, mem))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest
    const { Box, Button, Text } = $.ui.resolve(e)
    const s = await snapshot($, cfg)
    const d = lineData(s, cfg, await liveContext($))
    const chosen = bandFields(s, cfg)
    const segs: Segment[] = []
    let hasMain = false
    for (const f of chosen) {
      const pieces = piecesOf(f, d, false)
      if (!pieces) continue
      const isLimit = f === '5h' || f === '7d' || f === 'spend'
      // The plan's main limit stays in the band as long as the cache state does.
      // Shorter: the context as its share alone, a limit without its reset time.
      const short = f === 'context' && pieces.length === 3 ? [pieces[0]!, pieces[2]!] : isLimit && pieces.length > 2 ? pieces.slice(0, 2) : undefined
      segs.push({ key: f, prio: isLimit && !hasMain ? 1 : PRIO[f], pieces, short })
      if (isLimit) hasMain = true
    }

    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const DETAILS = 'Details'
    // The row's own padding takes a column each side.
    const { shown, withReserve } = fit(segs, columns - 2, DETAILS.length + 2)

    const row = (
      <Box key="vitals" flexDirection="row" paddingX={1}>
        {shown.map((s, i) => (
          <Box key={s.key} flexDirection="row" flexShrink={0}>
            {i > 0 ? <Text dimColor>{SEP}</Text> : null}
            {spaced(s.pieces).map(p => (
              <Text color={p.color} dimColor={p.dim} bold={p.bold}>{p.t}</Text>
            ))}
          </Box>
        ))}
        <Box key="grow" flexGrow={1} />
        {withReserve ? <Button key="details" label={DETAILS} plain dimColor onPress={() => void openPane($)} /> : null}
      </Box>
    )
    return rest ? <Box flexDirection="column">{rest}{row}</Box> : row
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const snap = await snapshot($, cfg)
    const { view, st, ls, ttl, now, total, w, warmOn, switched, guardMode, r, warmFrom, guardFrom, sent } = snap
    const me = snap.who
    const d = lineData(snap, cfg, await liveContext($))
    const lineText = lineOf(lineFields(snap, cfg), d)
    const LABEL = 14
    const tone = TONE[view.state]
    const inputs = st.read + st.write + st.uncached
    const cold = view.state === 'cold'
    const dot = '  ·  '

    // Everything is laid out in flex boxes and percentages, never counted in
    // characters, so the pane reflows at any width and in a proportional font.
    const Card = (p: { k: string; title: string; note?: RenderChildren; first?: boolean; children: RenderChildren }) => (
      <Box key={p.k} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={p.first ? 0 : 1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1} marginBottom={1}>
          <Text weight="semibold">{p.title}</Text>
          {p.note ?? null}
        </Box>
        <Box flexDirection="column" rowGap="xs">{p.children}</Box>
      </Box>
    )
    const Row = (p: { k: string; label: string; width?: number; children: RenderChildren }) => (
      <Box key={p.k} flexDirection="row" columnGap={1}>
        <Box width={p.width ?? LABEL} flexShrink={0}><Text dimColor wrap="truncate">{p.label}</Text></Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>{p.children}</Box>
      </Box>
    )
    /**
     * A meter of a fixed number of cells, filled and empty, as one line of text.
     * No box is sized in percent, so a graphical surface never stretches a rule
     * past its share, and nothing is cut with an ellipsis.
     */
    // As wide as the pane leaves beside the label, so a narrow pane never cuts it.
    const METER_CELLS = Math.max(8, Math.min(32, (e.props.bodyColumns ?? 60) - LABEL - 6))
    const Meter = (p: { share: number; color?: string }) => {
      const share = Number.isFinite(p.share) ? Math.max(0, Math.min(1, p.share)) : 0
      const filled = share > 0 ? Math.max(1, Math.round(share * METER_CELLS)) : 0
      return (
        <Text wrap="truncate-end">
          <Text color={p.color}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'─'.repeat(METER_CELLS - filled)}</Text>
        </Text>
      )
    }

    /** What this repo keeps for every session in it, with one button to keep the current state or hand it back. */
    const RepoRow = (p: { k: string; field: 'guard' | 'warm'; kept: boolean | null; isOn: boolean }) => (
      <Row k={p.k} label="This Repo">
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Text dimColor>{p.kept === null ? 'Follows settings' : p.kept ? 'Always on' : 'Always off'}</Text>
          <Button
            key={`${p.field}-repo`}
            label={p.kept === null ? `Keep ${p.isOn ? 'On' : 'Off'} Here` : 'Follow Settings'}
            variant="secondary"
            onPress={() => void setRepo($, p.field, p.kept === null ? p.isOn : null)}
          />
        </Box>
      </Row>
    )

    const byTab: Record<PaneTab, RenderChildren[]> = { now: [], context: [], cost: [], timeline: [], settings: [] }
    const put = (t: PaneTab, card: RenderChildren) => byTab[t].push(card)
    const effort = effortLabel(view.effort)
    const where = statusWhere(snap, cfg)

    // The account and the session stand under the figures that change: cache, next message, limits.
    const accountCard = (
      <Card k="account" title="Account">
        <Row k="acct-name" label="Label">
          <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
            <Text wrap="wrap">
              <Text bold>{me.label || 'None'}</Text>
              <Text dimColor>{`${dot}${cap(LABEL_FROM[me.labelFrom])}`}</Text>
            </Text>
            {me.labelFrom === 'own' ? <Button key="acct-reset" label="Reset" variant="secondary" onPress={() => void setAccountName($, cfg, null).then(() => refreshLine($, cfg, mem))} /> : null}
          </Box>
          {me.suggested && (me.labelFrom === 'letter' || me.labelFrom === 'single') ? (
            <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
              <Text dimColor>Label it</Text>
              <Button key="acct-suggested" label={me.suggested} variant="secondary" onPress={() => void setAccountName($, cfg, me.suggested).then(() => refreshLine($, cfg, mem))} />
            </Box>
          ) : null}
        </Row>
        <Row k="acct-rename" label="Rename">
          <Input
            key="acct-input"
            placeholder="Work, Personal, any name of yours"
            submitLabel="save"
            onSubmit={value => {
              const name = value.replace(/\s+/g, ' ').trim().slice(0, ACCOUNT_MAX)
              if (name) void setAccountName($, cfg, name).then(() => refreshLine($, cfg, mem))
            }}
          />
          <Text dimColor size="footnote" wrap="wrap">For every session on this account. /vitals account Work does the same.</Text>
        </Row>
        <Row k="acct-id" label="ID">
          <Text wrap="wrap">
            <Text mono>{me.id}</Text>
            <Text dimColor>{`${dot}Its config folder, which tells accounts apart`}</Text>
          </Text>
        </Row>
        {me.email ? <Row k="acct-email" label="E-mail"><Text wrap="wrap">{me.email}</Text></Row> : null}
      </Card>
    )
    // The model stands in the cache card once a request has gone; before that, here.
    const sessionCard = (view.state === 'none' && d.model) || me.mode || me.style || me.dir ? (
      <Card k="session-info" title="Session">
        {view.state === 'none' && d.model ? (
          <Row k="acct-model" label="Model">
            <Text wrap="wrap">
              <Text>{d.model}</Text>
              {effortLabel(d.effort) ? <Text dimColor>{`${dot}Effort ${effortLabel(d.effort)}`}</Text> : null}
            </Text>
          </Row>
        ) : null}
        {me.mode ? <Row k="acct-mode" label="Mode"><Text>{MODE_NAME[me.mode] ?? me.mode}</Text></Row> : null}
        {me.style ? <Row k="acct-style" label="Output Style"><Text>{me.style}</Text></Row> : null}
        {me.dir ? (
          <Row k="acct-dir" label="Folder">
            <Text wrap="wrap"><Text>{me.dir}</Text>{me.branch ? <Text dimColor>{`${dot}${me.branch}`}</Text> : null}</Text>
          </Row>
        ) : null}
      </Card>
    ) : null

    put('settings',
      <Card k="line" title="Status Line" note={<Text dimColor>{where === 'on' ? 'Pinned' : where === 'off' ? 'Off' : 'Terminal'}</Text>} first>
        <Row k="line-text" label="Reads">
          <Text>{lineText || 'Nothing to show yet'}</Text>
        </Row>
        <Row k="line-where" label="Where">
          <Text dimColor>
            {where === 'off' ? 'Nowhere' : where === 'on' ? 'Pinned under the prompt, and the terminal statusLine script' : 'The terminal statusLine script; the band covers the desktop app'}
          </Text>
        </Row>
        <Box marginTop={1}><Text dimColor size="footnote">/vitals line show, hide or set picks its fields, /vitals band the same for the band. /vitals line on pins it under the prompt too.</Text></Box>
      </Card>,
    )
    if (cfg.alfred.on) {
      put('settings',
        <Card k="alfred" title="Alfred">
          <Row k="alfred-sent" label="Usage">
            <Text dimColor>
              {sent.at === 0 ? 'Nothing sent yet' : sent.ok ? `Sent ${dur(now - sent.at)} ago${dot}${sent.sent} this session` : `Not sent: ${sent.error ?? `HTTP ${sent.status}`}`}
            </Text>
          </Row>
        </Card>,
      )
    }

    put('now',
      <Card k="cache" title="Prompt Cache" note={<Text dimColor>{`TTL ${ttl}`}</Text>} first>
        {view.state === 'none' ? (
          <Row k="state" label="State"><Text dimColor>{st.requests > 0 ? 'Known after the next reply' : 'No request yet'}</Text></Row>
        ) : (
          [
            <Row k="state" label="State">
              <Text>
                <Text color={tone} bold>{cold ? 'Cold' : 'Warm'}</Text>
                <Text dimColor>
                  {switched
                    ? `${dot}Model changed, the next message writes the cache anew`
                    : cold
                      ? view.why === 'compacted'
                        ? `${dot}The conversation was compacted, the next message caches its summary`
                        : view.why === 'unknown'
                          ? `${dot}After a break, idle time not known`
                          : `${dot}Idle ${dur(view.idleMs)}`
                      : `${dot}${dur(view.leftMs)} left${dot}Idle ${dur(view.idleMs)}`}
                </Text>
              </Text>
            </Row>,
            <Row k="ttl" label="Time Left"><Meter share={cold ? 0 : view.leftMs / TTL_MS[ttl]} color={tone} /></Row>,
            <Row k="model" label="Model">
              <Text>
                <Text>{nameOf(view)}</Text>
                {effort ? <Text dimColor>{`${dot}Effort `}</Text> : null}
                {effort ? <Text bold>{effort}</Text> : null}
                {view.price ? null : <Text dimColor>{`${dot}Not in the price table`}</Text>}
              </Text>
            </Row>,
            <Row k="ctx" label="Context">
              <Text>
                <Text tabular>{`${tok(view.ctx)} tokens`}</Text>
                {view.window ? <Text dimColor>{`${dot}${pct(view.ctx, view.window)}% of ${tok(view.window)}`}</Text> : null}
              </Text>
            </Row>,
            ...(view.window ? [<Row k="ctx-bar" label=""><Meter share={view.ctx / view.window} /></Row>] : []),
          ]
        )}
      </Card>,
    )

    if (view.state !== 'none' && view.price) {
      const price = view.price
      put('now',
        <Card k="next" title="Next Message" note={<Text dimColor>Re-sends the whole context</Text>}>
          <Row k="warm" label="While Warm">
            <Text>
              <Text tabular bold={!cold} color={cold ? undefined : 'success'}>{usd(view.warm)}</Text>
              <Text dimColor>{`${dot}Read at $${price.read}/MTok`}</Text>
            </Text>
          </Row>
          <Row k="cold" label="Once Cold">
            <Text>
              <Text tabular bold={cold} color={cold ? 'error' : undefined}>{usd(view.cold)}</Text>
              <Text dimColor>{`${dot}Write at $${writeRate(price, ttl)}/MTok`}</Text>
            </Text>
          </Row>
          {view.warm && view.cold ? (
            <Row k="ratio" label="Cold vs Warm">
              <Text><Text tabular>{`${Math.round(view.cold / view.warm)}x`}</Text><Text dimColor>{`${dot}More per message`}</Text></Text>
            </Row>
          ) : null}
        </Card>,
      )
    }

    const forHours = Math.round(cfg.warmForMs / 3_600_000)
    const pingIn = !switched && (view.state === 'warm' || view.state === 'soon') ? Math.max(0, view.leftMs - WARM_LEAD_MS[ttl]) : null
    const windowLeft = w.since ? cfg.warmForMs - (now - w.since) : cfg.warmForMs
    const pingUsd = warmUsd(view.price, view.ctx)
    put('settings',
      <Card
        k="keep-warm"
        title="Keep Warm"
        note={
          <Button
            key="keep-warm-toggle"
            label={warmOn ? 'Turn Off' : 'Turn On'}
            variant={warmOn ? 'secondary' : 'primary'}
            onPress={() => void setKeepWarm($, cfg)}
          />
        }
      >
        <Row k="kw-state" label="Status">
          <Text>
            <Text bold color={warmOn ? 'success' : undefined}>{warmOn ? 'On' : 'Off'}</Text>
            <Text dimColor>{`${dot}Up to ${forHours}h after your last message`}</Text>
          </Text>
        </Row>
        <Row k="kw-from" label="Set By"><Text dimColor>{LEVEL_NAME[warmFrom]}</Text></Row>
        {r.root ? <RepoRow k="kw-repo" field="warm" kept={r.warm} isOn={warmOn} /> : null}
        {warmOn ? (
          <Row k="kw-next" label="Next Ping">
            <Text dimColor>
              {pingIn == null
                ? 'After your next message'
                : windowLeft <= pingIn
                  ? 'None, the cache is let go after this window'
                  : `In ${dur(pingIn)}${pingUsd != null ? `, about ${usd(pingUsd)}` : ''}`}
            </Text>
          </Row>
        ) : null}
        <Row k="kw-pings" label="Pings">
          <Text>
            <Text tabular>{String(w.pings)}</Text>
            {w.pings ? <Text dimColor>{`${dot}${usd(w.usd)} in all`}</Text> : null}
            {w.missed ? <Text color="warning">{`${dot}${w.missed} too late`}</Text> : null}
          </Text>
        </Row>
        <Box marginTop={1}>
          <Text dimColor size="footnote">
            Shortly before the cache expires, a one-line question is forked on the same model, system prompt and context. It reads the cache instead of writing it, so the timer starts over. Nothing is added to the conversation.
          </Text>
        </Box>
      </Card>,
    )

    const guardOn = guardMode !== 'off'
    put('settings',
      <Card
        k="guard"
        title="Cold Send Guard"
        note={
          <Button
            key="guard-toggle"
            label={guardOn ? 'Turn Off' : 'Turn On'}
            variant={guardOn ? 'secondary' : 'primary'}
            onPress={() => void setGuard($, cfg)}
          />
        }
      >
        <Row k="guard-state" label="Status">
          <Text>
            <Text bold color={guardOn ? 'success' : undefined}>{guardOn ? 'On' : 'Off'}</Text>
            <Text dimColor>
              {`${dot}${guardMode === 'confirm' ? 'Holds the message once' : guardMode === 'warn' ? 'Only shows the price' : 'Every message goes straight through'}`}
            </Text>
          </Text>
        </Row>
        <Row k="guard-from" label="Set By"><Text dimColor>{LEVEL_NAME[guardFrom]}</Text></Row>
        {r.root ? <RepoRow k="guard-repo" field="guard" kept={r.guard} isOn={guardOn} /> : null}
        <Box marginTop={1}>
          <Text dimColor size="footnote">
            {`When the cache has gone cold and the context is over ${tok(GUARD_MIN_TOKENS)} tokens, the first message you send is held once with its re-cache price. Send it again to go ahead.`}
          </Text>
        </Box>
      </Card>,
    )

    put('cost',
      <Card k="session" title="This Session" first note={<Text dimColor>Main thread</Text>}>
        {st.requests === 0 ? (
          <Row k="none" label="Requests"><Text dimColor>None yet</Text></Row>
        ) : (
          [
            <Row k="req" label="Requests"><Text tabular>{String(st.requests)}</Text></Row>,
            <Row k="hit" label="Cache Hit">
              <Text>
                <Text bold tabular>{`${pctDown(st.read, inputs)}%`}</Text>
                <Text dimColor>{`${dot}${tok(st.read)} read${dot}${tok(st.write)} written${dot}${tok(st.uncached)} uncached`}</Text>
              </Text>
            </Row>,
            <Row k="hit-bar" label=""><Meter share={inputs ? st.read / inputs : 0} color="success" /></Row>,
            <Row k="saved" label="Cache Saved">
              <Text><Text color="success" tabular>{usd(st.savedUsd)}</Text><Text dimColor>{`${dot}Compared to full input price`}</Text></Text>
            </Row>,
            <Row k="cold-writes" label="Cold Writes">
              <Text>
                <Text tabular color={st.coldWrites ? 'warning' : undefined}>{String(st.coldWrites)}</Text>
                {st.coldWrites ? <Text dimColor>{`${dot}${usd(st.coldUsd)} spent re-caching`}</Text> : null}
              </Text>
            </Row>,
            ...(st.last
              ? [
                  <Row k="last" label="Last Request">
                    <Text>
                      <Text tabular>{usd(st.last.usd)}</Text>
                      <Text dimColor>{`${dot}${dur(now - st.last.at)} ago`}</Text>
                    </Text>
                    <Text dimColor>
                      {`${tok(st.last.read)} read${dot}${tok(st.last.write)} written${dot}${tok(st.last.uncached)} new${dot}${tok(st.last.output)} out`}
                    </Text>
                  </Row>,
                ]
              : []),
          ]
        )}
        {total != null ? (
          <Row k="total" label="Session Total">
            <Text><Text tabular>{usd(total)}</Text><Text dimColor>{`${dot}All requests, subagents too`}</Text></Text>
          </Row>
        ) : null}
      </Card>,
    )

    if (ls.length > 0) {
      put('now',
        <Card k="limits" title="Usage Limits">
          {ls.map(l => {
            const used = Math.round(l.percentUsed)
            const reset = resetIn(l.resetsAt, now)
            return (
              <Row k={`l-${l.kind}`} label={LIMIT_NAME[l.kind] ?? l.kind}>
                {reset === 'now' ? (
                  <Text dimColor>Just reset, updated with the next reply</Text>
                ) : (
                  <Text>
                    <Text bold tabular color={limitTone(used)}>{`${used}%`}</Text>
                    {reset ? <Text dimColor>{`${dot}${reset}`}</Text> : null}
                  </Text>
                )}
                {reset === 'now' ? null : <Meter share={used / 100} color={limitTone(used)} />}
              </Row>
            )
          })}
        </Card>,
      )
    }

    put('now', accountCard)
    if (sessionCard) put('now', sessionCard)

    put('cost',
      <Box key="foot" marginTop={1} paddingX={1}>
        <Text dimColor size="footnote">
          {ls.length > 0
            ? 'Dollar figures are API list prices. On a subscription they show how much of your limits a message takes, not a bill.'
            : 'Dollar figures are API list prices from the table in hooks/cache.ts.'}
        </Text>
      </Box>,
    )

    // Context: how full, what fills it, when auto-compact runs and whether to compact now.
    const info = snap.info
    const share = snap.share
    const autoAt = snap.autoAt
    const ctxTokens = view.state !== 'none' ? view.ctx : (snap.live.tokens ?? 0)
    const ctxWindow = (view.state !== 'none' && view.window) || snap.live.window || info?.window || 0
    put('context',
      <Card
        k="ctx"
        title="Context"
        note={<Button key="compact-now" label="Compact Now" variant={snap.advice ? 'primary' : 'secondary'} onPress={() => void compactNow($, mem)} />}
        first
      >
        <Row k="ctx-used" label="Used">
          <Text>
            <Text tabular bold>{share != null ? `${share}%` : '-'}</Text>
            <Text dimColor>{`${dot}${tok(ctxTokens)} of ${ctxWindow ? tok(ctxWindow) : '?'} tokens`}</Text>
          </Text>
          <Meter share={share != null ? share / 100 : 0} color={autoAt != null && share != null && share >= autoAt - 10 ? 'warning' : undefined} />
        </Row>
        <Row k="ctx-auto" label="Auto-Compact">
          <Box flexDirection="row" columnGap={1} alignItems="center">
            <Text>
              <Text bold color={info?.autoOn === false ? 'warning' : undefined}>{info?.autoOn === false ? 'Off' : 'On'}</Text>
              {autoAt != null ? <Text dimColor>{`${dot}Runs at ${autoAt}%${share != null && autoAt > share ? `, ${autoAt - share} points to go` : ''}`}</Text> : null}
            </Text>
            <Button key="auto-toggle" label={info?.autoOn === false ? 'Turn On' : 'Turn Off'} variant="secondary" onPress={() => void setAutoCompact($)} />
          </Box>
        </Row>
        <Row k="ctx-advice" label="Advice">
          <Text color={snap.advice ? 'warning' : undefined} dimColor={!snap.advice}>
            {snap.advice
              ? `Compact now: ${snap.advice}.`
              : !cfg.compact.on
                ? 'The compact hint is off in the settings.'
                : 'No need yet.'}
          </Text>
        </Row>
        <Box marginTop={1}>
          <Text dimColor size="footnote">
            {`Compacting costs about one pass over the context. Best at a break of your choosing: when the cache has gone cold and the context is over ${cfg.compact.coldAt}% (the next message pays that pass anyway), or before auto-compact cuts in mid-task.`}
          </Text>
        </Box>
      </Card>,
    )
    if (info && info.categories.length > 0) {
      const whole = ctxWindow || info.window || 0
      const usedSum = info.categories.reduce((n, c) => n + c.tokens, 0)
      put('context',
        <Card k="ctx-parts" title="What Fills It" note={<Text dimColor>{`${tok(usedSum)} in the window, estimated as /context`}</Text>}>
          {info.categories.slice(0, 8).map(c => (
            <Row k={`cat-${c.name}`} label={c.name}>
              <Text>
                <Text tabular>{tok(c.tokens)}</Text>
                {whole ? <Text dimColor>{`${dot}${pct(c.tokens, whole)}% of the window`}</Text> : null}
              </Text>
              <Meter share={whole ? c.tokens / whole : 0} />
            </Row>
          ))}
          {info.deferred > 0 || info.buffer > 0 ? (
            <Box marginTop={1} flexDirection="column">
              {info.deferred > 0 ? <Text dimColor size="footnote">{`Not counted: ${tok(info.deferred)} of tool schemas load only when a tool is searched for (deferred), so they take no room until then.`}</Text> : null}
              {info.buffer > 0 ? <Text dimColor size="footnote">{`Kept free: ${tok(info.buffer)} that auto-compact reserves to summarise in.`}</Text> : null}
            </Box>
          ) : null}
        </Card>,
      )
    }
    if (info && info.mcp.length > 0) {
      const inWindow = info.mcp.some(m => m.tokens > 0)
      put('context',
        <Card k="ctx-mcp" title="Heaviest MCP Servers" note={<Text dimColor>{inWindow ? 'Tool schemas in the window' : 'All load on demand'}</Text>}>
          {info.mcp.map(m => (
            <Box key={`mcp-${m.server}`} flexDirection="row" justifyContent="space-between" columnGap={2}>
              <Box flexShrink={1}><Text wrap="truncate-end">{m.label}</Text></Box>
              <Box flexShrink={0}>
                <Text>
                  <Text tabular>{m.tokens > 0 ? tok(m.tokens) : 'none'}</Text>
                  {m.deferred > 0 ? <Text dimColor>{`${dot}${tok(m.deferred)} on demand`}</Text> : null}
                </Text>
              </Box>
            </Box>
          ))}
          {info.mcp.some(m => m.label !== m.server.replace(/^claude\.ai /, '')) ? (
            <Box marginTop={1}><Text dimColor size="footnote" wrap="wrap">The desktop app knows connectors from claude.ai by an id alone, so those are named after their tools.</Text></Box>
          ) : null}
        </Card>,
      )
    }
    put('settings',
      <Card k="compact-hint" title="Compact Hint" note={<Text dimColor>{cfg.compact.on ? 'On' : 'Off'}</Text>}>
        <Row k="hint-cold" label="Cold Cache">
          <Text dimColor>{`From ${cfg.compact.coldAt}% of the window`}</Text>
        </Row>
        <Row k="hint-auto" label="Auto-Compact">
          <Text dimColor>Within 10 points of its threshold, or from 80% when it is off</Text>
        </Row>
        <Box marginTop={1}><Text dimColor size="footnote">compactHint and compactAt in /plugin configure change it.</Text></Box>
      </Card>,
    )

    // Timeline: when each message went and how long each reply took.
    const tl = await read($, timeline)
    put('timeline',
      <Card k="timeline" title="Timeline" note={<Text dimColor>{(n => `${n} ${n === 1 ? 'message' : 'messages'} from you`)(tl.filter(x => x.who === 'you').length)}</Text>} first>
        {tl.length === 0 ? (
          <Text dimColor>Nothing yet. Each message you send and each reply shows here with its time.</Text>
        ) : (
          // The newest first. A gap that let the cache go cold stands under the message that paid for it.
          tl.map((x, i) => ({ x, gap: i > 0 && x.who !== 'claude' ? x.at - tl[i - 1]!.at : 0 })).slice(-TIMELINE_SHOWN).reverse().flatMap(({ x, gap }) => {
            const rows: RenderChildren[] = []
            const clock = stampOf(x.at, now, me.tzMin)
            rows.push(
              <Row k={`tl-${x.at}-${x.who}`} label={clock} width={clock.length > 5 ? 10 : 6}>
                {x.who === 'claude' ? (
                  <Box flexDirection="column">
                    <Text wrap="wrap">
                      <Text bold>Claude</Text>
                      <Text dimColor>{`${x.ms != null ? `${dot}took ${dur(x.ms)}` : ''}${x.tools ? `${dot}${x.tools} ${x.tools === 1 ? 'tool' : 'tools'}` : ''}`}</Text>
                    </Text>
                    {x.text ? <Text dimColor wrap="wrap">{plain(x.text)}</Text> : null}
                  </Box>
                ) : (
                  <Box flexDirection="column">
                    <Text wrap="wrap">
                      <Text bold color={x.who === 'you' ? undefined : 'suggestion'}>{WHO_NAME[x.who] ?? 'You'}</Text>
                      {x.from ? <Text dimColor>{`${dot}${x.from}`}</Text> : null}
                    </Text>
                    {x.text ? <Text dimColor={x.who !== 'you'} wrap="wrap">{plain(x.text)}</Text> : null}
                  </Box>
                )}
              </Row>,
            )
            if (gap > TTL_MS[ttl]) rows.push(<Text key={`gap-${x.at}`} color="error" size="footnote" wrap="wrap">{`${dur(gap)} idle before it, the cache had gone cold`}</Text>)
            return rows
          })
        )}
      </Card>,
    )

    const current = await read($, tab)
    const tabs = (
      <Box key="tabs" flexDirection="row" columnGap={1} marginBottom={1} flexWrap="wrap">
        {TABS.map(t => (
          <Button key={`tab-${t.id}`} label={t.label} variant={t.id === current ? 'primary' : 'secondary'} onPress={() => void update($, tab, () => t.id)} />
        ))}
      </Box>
    )
    return <Box flexDirection="column">{tabs}{byTab[current]}</Box>
  })
}

/** The pane's figures as plain lines, for a surface that cannot seat the pane. */
const summary = (
  v: CacheView, st: Stats, ls: readonly Limit[], ttl: Ttl, now: number, total: number | null, warmOn: boolean, w: KeepWarm, switched: string | null,
  guardMode: GuardMode, warmFrom: Level, guardFrom: Level,
): string[] => {
  const out: string[] = []
  const line = (label: string, value: string) => out.push(`${label.padEnd(14)}${value}`)
  const effort = effortLabel(v.effort)
  if (v.state === 'none') line('Prompt Cache', st.requests ? 'Known after the next reply' : 'No request yet')
  else {
    const idle = v.why === 'compacted' ? 'after compaction' : v.why === 'unknown' ? 'after a break' : `idle ${dur(v.idleMs)}`
    const state = switched ? 'Cold, the model changed' : v.state === 'cold' ? `Cold, ${idle}` : `Warm, ${dur(v.leftMs)} left`
    line('Prompt Cache', `${state} (TTL ${ttl})`)
    line('Context', `${tok(v.ctx)} tokens${v.window ? `, ${pct(v.ctx, v.window)}% of ${tok(v.window)}` : ''}`)
    line('Model', `${nameOf(v)}${effort ? `, effort ${effort}` : ''}${v.price ? '' : ', not in the price table'}`)
    if (v.price) line('Next Message', `${usd(v.warm)} warm, ${usd(v.cold)} cold`)
  }
  line('Keep Warm', `${warmOn ? 'On' : 'Off'} (${LEVEL_NAME[warmFrom]}), ${w.pings} pings (${usd(w.usd)}). /vitals warm switches it.`)
  line('Cold Guard', `${guardMode === 'off' ? 'Off' : guardMode === 'warn' ? 'On, only shows the price' : 'On, holds the message once'} (${LEVEL_NAME[guardFrom]}). /vitals guard switches it.`)
  const inputs = st.read + st.write + st.uncached
  if (st.requests && inputs) {
    line('Cache Hit', `${pctDown(st.read, inputs)}% over ${st.requests} requests, saved ${usd(st.savedUsd)}, ${st.coldWrites} cold writes (${usd(st.coldUsd)})`)
  }
  if (total != null) line('Session Total', usd(total))
  for (const l of ls) {
    const reset = resetIn(l.resetsAt, now)
    line(LIMIT_NAME[l.kind] ?? l.kind, reset === 'now' ? 'Just reset' : `${Math.round(l.percentUsed)}% used${reset ? `, resets in ${reset}` : ''}`)
  }
  return out
}
