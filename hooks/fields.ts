// The fields the band and the status line are made of, and how each one reads. Pure, no engine.

import type { Limit } from '../types'
import type { Piece } from './band'
import { LIMIT_NAME, TONE, dur, effortLabel, limitTone, pct, tok, usd } from './cache'
import type { CacheView } from './cache'

export const FIELDS = [
  'account', 'email', 'model', 'effort', 'mode', 'style', 'dir', 'branch',
  'cache', 'next', 'ifcold', 'context', 'compact', 'hit', '5h', '7d', 'spend', 'session',
] as const
export type Field = (typeof FIELDS)[number]

/** What each field shows, for `/vitals fields` and the README. */
export const FIELD_INFO: Record<Field, string> = {
  account: 'Account label: your own (/vitals account Work), else the name in its config folder (.claude-work is Work) or a letter (A, B, C); hidden with one account',
  email: 'E-mail of the signed-in account (shown only, never sent anywhere)',
  model: 'Model with its version (Opus 5.5)',
  effort: 'Reasoning effort (low, medium, high, xhigh, max)',
  mode: 'Permission mode (default, accept edits, plan, auto, bypass)',
  style: 'Output style, when it is not the default',
  dir: 'Working folder',
  branch: 'Git branch',
  cache: 'Prompt cache warm or cold, with time left or idle time',
  next: 'What the next message costs (a cache read, or a re-cache when cold)',
  ifcold: 'What the next message would cost once the cache is cold',
  context: 'Context tokens and share of the window',
  compact: 'A hint to compact: the context is large while the cache is cold, or auto-compact is near',
  hit: 'Cache hit rate of the session',
  '5h': '5-hour usage limit with its reset',
  '7d': 'Weekly usage limit with its reset',
  spend: 'Spend limit of a gateway, where there is one',
  session: 'What the session has cost (API list prices)',
}

/** One row above the prompt: what Claude does not show on its own, nothing it does. */
export const BAND_DEFAULT: readonly Field[] = ['cache', 'next', 'account', '5h', '7d', 'spend', 'context', 'compact']
/** The terminal status line: Claude's terminal footer has no model or effort, so the line carries them. */
export const LINE_DEFAULT: readonly Field[] = ['account', 'model', 'effort', 'cache', 'next', '5h', '7d', 'context', 'compact', 'branch']

const ALIAS: Record<string, Field | Field[]> = {
  weekly: '7d', week: '7d', '7-day': '7d', seven_day: '7d',
  '5-hour': '5h', five_hour: '5h', '5hour': '5h',
  limits: ['5h', '7d', 'spend'],
  cold: 'ifcold', 'if-cold': 'ifcold',
  ctx: 'context',
  compaction: 'compact', autocompact: 'compact',
  cost: 'session', usd: 'session',
  hitrate: 'hit', 'hit-rate': 'hit',
  permissions: 'mode', permission: 'mode',
  'output-style': 'style', outputstyle: 'style',
  cwd: 'dir', folder: 'dir',
  git: 'branch',
  label: 'account', konto: 'account',
  mail: 'email', 'e-mail': 'email',
}

/** One word to a field, or null for a word that names none. */
export const fieldOf = (word: string): Field[] | null => {
  const w = word.trim().toLowerCase()
  if ((FIELDS as readonly string[]).includes(w)) return [w as Field]
  const a = ALIAS[w]
  return a === undefined ? null : Array.isArray(a) ? a : [a]
}

/** A list as typed (`account, model 7d`): the fields in order, once each, and the words that named none. */
export const parseFields = (text: unknown): { fields: Field[]; unknown: string[] } => {
  const fields: Field[] = []
  const unknown: string[] = []
  for (const word of String(text ?? '').split(/[\s,;|]+/).filter(Boolean)) {
    const f = fieldOf(word)
    if (!f) unknown.push(word)
    else for (const x of f) if (!fields.includes(x)) fields.push(x)
  }
  return { fields, unknown }
}

/** A list from the settings, or the default when the setting is empty or names no field. */
export const fieldsOr = (text: unknown, fallback: readonly Field[]): Field[] => {
  const { fields } = parseFields(text)
  return fields.length > 0 ? fields : [...fallback]
}

/** `my-team` as `My Team`: a folder's own words, each capitalised. */
const titleWords = (text: string): string =>
  text.split(/[-_.\s]+/).filter(Boolean).map(w => w[0]!.toUpperCase() + w.slice(1)).join(' ')

/**
 * Where an account's label comes from, strongest first: the person's own name
 * for it (`/vitals account Work`), the `accountLabels` setting, a name the
 * config folder itself carries (`.claude-work` is Work), else a letter
 * (`.claude` is A, `.claude-b` is B).
 */
export type AccountFrom = 'own' | 'setting' | 'folder' | 'letter'

/**
 * The account a session runs under. Its id is its config folder's name
 * (`.claude`, `.claude-b`): what tells one account from another on this
 * machine and never changes. Its label is what the band shows, and anyone can
 * set it. `labels` (`.claude-b=Work, A=1`) names a folder by its full path,
 * its name with or without the dot, or its default label.
 */
export const accountOf = (
  configDir: string | undefined,
  home: string | undefined,
  labels: unknown,
  own?: unknown,
): { label: string; id: string; dir: string; from: AccountFrom } => {
  const h = (home ?? '').replace(/\/+$/, '')
  const dir = (configDir ?? '').replace(/\/+$/, '') || `${h}/.claude`
  const id = dir.split('/').pop() || dir
  const isDefault = id === '.claude' || id === 'claude'
  const rest = isDefault ? '' : id.replace(/^\.?claude[-_.]?/i, '').replace(/^\./, '') || id.replace(/^\./, '')
  // One or two characters, or a number, is a letter of the person's own (B, C, 2); anything longer is a name.
  const isLetter = isDefault || rest.length <= 2 || /^\d+$/.test(rest)
  const auto = isDefault ? 'A' : isLetter ? rest.toUpperCase() : titleWords(rest)
  if (typeof own === 'string' && own.trim()) return { label: own.trim(), id, dir, from: 'own' }
  const keys = new Set([dir, id, id.replace(/^\./, ''), auto.toLowerCase()])
  for (const pair of String(labels ?? '').split(/[,;\n]+/)) {
    const at = pair.indexOf('=')
    if (at < 0) continue
    const key = pair.slice(0, at).trim().replace(/^~(?=\/)/, h).replace(/\/+$/, '')
    const value = pair.slice(at + 1).trim()
    if (value && (keys.has(key) || keys.has(key.toLowerCase()))) return { label: value, id, dir, from: 'setting' }
  }
  return { label: auto, id, dir, from: isLetter ? 'letter' : 'folder' }
}

/** Where the account keeps its login record: `~/.claude.json` for the default folder, else inside the folder. */
export const loginFileOf = (configDir: string | undefined, home: string | undefined): string[] => {
  const h = (home ?? '').replace(/\/+$/, '')
  const dir = (configDir ?? '').replace(/\/+$/, '')
  if (!dir) return [`${h}/.claude.json`]
  return dir === `${h}/.claude` ? [`${dir}/.claude.json`, `${h}/.claude.json`] : [`${dir}/.claude.json`]
}

export type ResetStyle = 'auto' | 'countdown' | 'clock' | 'both'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (n: number) => String(n).padStart(2, '0')

/**
 * A reset as a clock time in the person's zone (`tzMin` east of UTC): `14:40`
 * within a day, `Sun 05:00` further off. Empty for a missing or bad time.
 */
export const clockOf = (iso: string | undefined, now: number, tzMin: number): string => {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const d = new Date(at + tzMin * 60_000)
  const hm = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
  return at - now < 20 * 3_600_000 ? hm : `${DAYS[d.getUTCDay()]} ${hm}`
}

/** Everything a field reads, gathered once per drawing. */
export type LineData = {
  label: string
  email: string | null
  mode: string | null
  style: string | null
  dir: string | null
  branch: string | null
  model: string | null
  effort: string | number | null
  view: CacheView
  switched: boolean
  warmOn: boolean
  requests: number
  /** Share of input read from the cache, rounded down; null before the first request. */
  hit: number | null
  /** The live window as the engine has it, for the context before this session's first reply. */
  context: { tokens?: number; window: number; percent?: number }
  /** Why compacting now is a good idea, in a few words; null when it is not. */
  advice: string | null
  limits: readonly Limit[]
  now: number
  total: number | null
  reset: ResetStyle
  tzMin: number
}

export const MODE_NAME: Record<string, string> = {
  default: 'default', acceptEdits: 'accept edits', plan: 'plan', auto: 'auto', bypassPermissions: 'bypass', dontAsk: "don't ask",
}
const LIMIT_SHORT: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const KIND: Partial<Record<Field, string>> = { '5h': 'five_hour', '7d': 'seven_day', spend: 'spend_limit' }

/** The effort as the status line spells it: the level itself, a budget in tokens. */
const effortShort = (e: string | number | null): string | null => (e == null ? null : typeof e === 'number' ? `${tok(e)} budget` : e)

/**
 * One field as pieces, `compact` for the status line and full for the band;
 * null when there is nothing true to show (no figure is ever guessed).
 */
export const piecesOf = (f: Field, d: LineData, compact: boolean): Piece[] | null => {
  const v = d.view
  const cold = v.state === 'cold'
  const tone = TONE[v.state]
  switch (f) {
    case 'account':
      return d.label ? [{ t: d.label, bold: true }] : null
    case 'email':
      return d.email ? [{ t: d.email, dim: !compact }] : null
    case 'model':
      return d.model ? [{ t: d.model }] : null
    case 'effort': {
      const e = compact ? effortShort(d.effort) : effortLabel(d.effort)
      return e ? (compact ? [{ t: e }] : [{ t: 'Effort', dim: true }, { t: e }]) : null
    }
    case 'mode': {
      if (!d.mode) return null
      const m = MODE_NAME[d.mode] ?? d.mode
      return compact ? [{ t: m }] : [{ t: 'Mode', dim: true }, { t: m, color: d.mode === 'bypassPermissions' ? 'warning' : undefined }]
    }
    case 'style':
      return d.style && d.style.toLowerCase() !== 'default' ? [{ t: 'Style', dim: true }, { t: d.style }] : null
    case 'dir':
      return d.dir ? [{ t: d.dir, dim: !compact }] : null
    case 'branch':
      return d.branch ? [{ t: '⎇', dim: true }, { t: d.branch }] : null
    case 'cache': {
      if (v.state === 'none') {
        if (compact) return null
        return [{ t: '○', dim: true }, { t: 'Prompt Cache', bold: true }, { t: d.requests > 0 ? 'Known after the next reply' : 'Waiting for the first reply', dim: true }]
      }
      // Why it is cold, never a word that could be read as the cache's own state: the conversation is
      // what gets compacted, the cache is cold because of it.
      const why = d.switched ? 'model changed' : v.why === 'compacted' ? 'after compaction' : v.why === 'unknown' ? 'after a break' : `idle ${dur(v.idleMs)}`
      const when = cold ? why : `${dur(v.leftMs)} left`
      if (compact) return [{ t: '●', color: tone }, { t: cold ? 'Cold' : 'Warm', color: tone }, { t: cold ? why : dur(v.leftMs) }]
      return [
        { t: '●', color: tone },
        { t: 'Cache', dim: true },
        { t: cold ? 'Cold' : 'Warm', color: tone, bold: true },
        cold ? { t: when[0]!.toUpperCase() + when.slice(1), dim: true } : { t: when, color: v.state === 'soon' ? tone : undefined },
        ...(d.warmOn && !cold ? [{ t: 'Kept Warm', dim: true }] : []),
      ]
    }
    case 'next':
      if (v.state === 'none') return null
      if (cold) return v.cold == null ? null : [{ t: compact ? 'next' : 'Next', dim: true }, { t: usd(v.cold), color: 'error', bold: true }, ...(compact ? [] : [{ t: 'Re-cache', dim: true }])]
      if (v.warm == null) return null
      // In its last minutes the band also says what waiting longer would cost.
      return [
        { t: compact ? 'next' : 'Next', dim: true }, { t: usd(v.warm), bold: !compact },
        ...(!compact && v.state === 'soon' && v.cold != null ? [{ t: 'then', dim: true }, { t: usd(v.cold), color: tone }] : []),
      ]
    case 'ifcold':
      return v.state === 'none' || cold || v.cold == null ? null : [{ t: compact ? 'if cold' : 'If Cold', dim: true }, { t: usd(v.cold) }]
    case 'context': {
      const tokens = v.state !== 'none' ? v.ctx : d.context.tokens
      const window = v.state !== 'none' && v.window ? v.window : d.context.window
      if (!tokens) return null
      const share = window ? pct(tokens, window) : d.context.percent
      if (compact) return [{ t: 'ctx', dim: true }, { t: share != null ? `${share}%` : tok(tokens) }]
      return [{ t: 'Context', dim: true }, { t: tok(tokens) }, ...(share != null ? [{ t: `${share}%`, dim: true }] : [])]
    }
    case 'compact':
      if (!d.advice) return null
      return compact ? [{ t: 'compact?', color: 'warning' }] : [{ t: 'Compact', color: 'warning', bold: true }, { t: d.advice, dim: true }]
    case 'hit':
      return d.hit == null ? null : [{ t: compact ? 'hit' : 'Hit Rate', dim: true }, { t: `${d.hit}%` }]
    case '5h':
    case '7d':
    case 'spend': {
      const l = d.limits.find(x => x.kind === KIND[f])
      return l ? limitPieces(l, d, compact) : null
    }
    case 'session':
      return d.total != null && d.total > 0 ? (compact ? [{ t: usd(d.total) }] : [{ t: 'Session', dim: true }, { t: usd(d.total) }]) : null
  }
}

/** One usage window: name, percent used in its tone, and its reset as the settings say. */
export const limitPieces = (l: Limit, d: Pick<LineData, 'now' | 'reset' | 'tzMin'>, compact: boolean): Piece[] => {
  const name = compact ? (LIMIT_SHORT[l.kind] ?? l.kind) : (LIMIT_NAME[l.kind] ?? l.kind)
  const ms = l.resetsAt ? Date.parse(l.resetsAt) - d.now : NaN
  if (!Number.isNaN(ms) && ms <= 0) return [{ t: name, dim: true }, { t: compact ? 'reset' : 'Just reset', dim: true }]
  const used = Math.round(l.percentUsed)
  // A countdown everywhere unless asked otherwise: days and hours, then hours and minutes within a day.
  const style = d.reset === 'auto' ? 'countdown' : d.reset
  const countdown = Number.isNaN(ms) ? '' : dur(ms)
  const clock = clockOf(l.resetsAt, d.now, d.tzMin)
  const when =
    style === 'clock' ? (clock ? (compact ? `(${clock})` : clock) : '')
      : style === 'both' ? [countdown, clock ? `(${clock})` : ''].filter(Boolean).join(' ')
        : countdown
  return [{ t: name, dim: true }, { t: `${used}%`, color: limitTone(used), bold: !compact }, ...(when ? [{ t: when, dim: true }] : [])]
}

/** The status line as text: each field's pieces one space apart, fields split by a middle dot, as `A · Opus 5.5 · medium`. */
export const lineOf = (fields: readonly Field[], d: LineData): string => {
  const parts: string[] = []
  for (const f of fields) {
    const p = piecesOf(f, d, true)
    if (p && p.length > 0) parts.push(p.map(x => x.t).join(' '))
  }
  return parts.join(' · ')
}

/** How long a field may stay in the band as it narrows: the lower, the longer. */
export const PRIO: Record<Field, number> = {
  cache: 0, account: 1, context: 1, '5h': 3, '7d': 3, spend: 3, next: 2, compact: 2, model: 4, ifcold: 4, hit: 5, effort: 5,
  session: 6, mode: 6, branch: 7, dir: 8, style: 8, email: 9,
}
