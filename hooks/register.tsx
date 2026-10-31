import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { CacheFacts, EngineCache, KeepWarm, Limit, Stats } from '../types'
import { SEP, fit, spaced } from './band'
import type { Segment } from './band'
import {
  COLD_WRITE_MIN, COLD_WRITE_SHARE, GUARD_MIN_TOKENS, LIMIT_NAME, TONE, TTL_MS, WARM_FOR_MS, WARM_LEAD_MS,
  dur, effortLabel, limitTone, modelName, pct, pctDown, priceOf, requestUsd, resetIn, sortLimits, tok, usd, viewOf, warmUsd, writeRate,
} from './cache'
import type { CacheView, Ttl } from './cache'

// A quiet meter above the prompt: whether the prompt cache is warm or cold,
// how long it has left, how big the context is, what the next message costs
// warm and cold, the session's cache hit rate and the usage limits the account
// has. /cache opens a pane with the full breakdown. Keep Warm, off unless
// switched on, pings the cache with a one-line fork before it expires.

const PANE = 'cache-meter'
const TITLE = 'Prompt Cache'
/** How often the band redraws, so the countdown and the warm-to-cold flip stay current. */
const TICK_MS = 15_000
/** The fork Keep Warm sends: the session's own prefix plus this, so the reply stays one word. */
const PING = 'Cache keep-alive ping from the Cache Meter plugin. Reply with the single word OK and nothing else.'

const EMPTY_STATS: Stats = { requests: 0, read: 0, write: 0, uncached: 0, output: 0, savedUsd: 0, coldWrites: 0, coldUsd: 0, last: null }
const EMPTY_WARM: KeepWarm = { on: null, since: 0, streak: 0, pings: 0, usd: 0, lastPingAt: 0, missed: 0 }
const EMPTY_ENGINE: EngineCache = { ttl: null, switchedTo: null }

const facts = atom({ plugin: 'cache-meter', key: 'facts' } as const, null as CacheFacts | null, { shape: 'facts-2' })
const limits = atom({ plugin: 'cache-meter', key: 'limits' } as const, [] as Limit[], { shape: 'limits-1' })
const stats = atom({ plugin: 'cache-meter', key: 'stats' } as const, EMPTY_STATS, { shape: 'stats-1' })
const sessionUsd = atom({ plugin: 'cache-meter', key: 'sessionUsd' } as const, null as number | null, { shape: 'usd-1' })
const warm = atom({ plugin: 'cache-meter', key: 'warm' } as const, EMPTY_WARM, { shape: 'warm-1' })
const engine = atom({ plugin: 'cache-meter', key: 'engine' } as const, EMPTY_ENGINE, { shape: 'engine-1' })

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
/** What register reads from the settings, handed to the top-level helpers. */
type Settings = { ttl: TtlOption; warmDefault: boolean; warmForMs: number }
/** Keep Warm's one ping in flight, so ticks never overlap one. */
type PingRun = { busy: boolean }

/**
 * The TTL: the setting when set by hand, else what the engine said it caches
 * with, else a guess: a subscription reports usage limits and caches for an
 * hour, an API key for 5 minutes.
 */
const resolveTtl = (option: TtlOption, ls: readonly Limit[], said: Ttl | null): Ttl =>
  option !== 'auto' ? option : (said ?? (ls.length > 0 ? '1h' : '5m'))

const isWarmOn = (w: KeepWarm, cfg: Settings): boolean => w.on ?? cfg.warmDefault

/** The model as people name it, never a raw id where a name can be read. */
const nameOf = (v: CacheView): string => v.price?.name ?? modelName(v.model) ?? v.model ?? 'Unknown model'

/** Everything the band, the pane and the guard read, at one moment. */
async function snapshot($: EngineInterface, cfg: Settings) {
  const ls = await read($, limits)
  const eng = await read($, engine)
  const ttl = resolveTtl(cfg.ttl, ls, eng.ttl)
  const now = await $.clock.now()
  const w = await read($, warm)
  const f = await read($, facts)
  // A model switched to since the last request has no cache of this context:
  // the next message writes all of it, on the new model's price.
  const switched = f && eng.switchedTo && eng.switchedTo !== f.model ? eng.switchedTo : null
  const base = viewOf(switched && f ? { ...f, model: switched } : f, now, ttl)
  const view: CacheView = switched && base.state !== 'none' ? { ...base, state: 'cold', leftMs: 0 } : base
  return {
    ls, ttl, now, w, view, switched,
    st: await read($, stats),
    total: await read($, sessionUsd),
    warmOn: isWarmOn(w, cfg),
  }
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE })
}

/** Switches Keep Warm for this session; `to` left out flips it. */
async function setKeepWarm($: EngineInterface, cfg: Settings, to?: boolean): Promise<boolean> {
  const now = await $.clock.now()
  let isOn = false
  await update($, warm, w => {
    isOn = to ?? !isWarmOn(w, cfg)
    // Switching on counts the window from now, so it never pings for a message long gone.
    return { ...w, on: isOn, since: isOn ? Math.max(w.since, now) : w.since, streak: isOn ? 0 : w.streak }
  })
  $.ui.invalidate('ui.render')
  return isOn
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
    if (!isHit) $.ui.toast('Cache Meter: Keep Warm found the cache already expired and switched itself off.')
  } finally {
    run.busy = false
    $.ui.invalidate('ui.render')
  }
}

export const register: Register = (on, options) => {
  const cfg: Settings = {
    ttl: options.ttl === '1h' || options.ttl === '5m' ? options.ttl : 'auto',
    warmDefault: options.keepWarm === 'on',
    warmForMs: WARM_FOR_MS[String(options.keepWarmFor)] ?? WARM_FOR_MS['2h']!,
  }
  const guard = options.guard === 'warn' || options.guard === 'off' ? options.guard : 'confirm'
  const run: PingRun = { busy: false }
  /** The cold send the person was already told about: its resend goes through. */
  let ackedAt = 0

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const u = await $.session.usage()
    await update($, limits, () => cleanLimits(u.rateLimits))
    await update($, sessionUsd, () => u.cost?.usd ?? null)
    await $.command.register({
      name: 'cache',
      description: 'Prompt Cache: state, context, warm and cold cost, hit rate, usage limits and Keep Warm (Cache Meter)',
      argumentHint: '[warm [on|off]]',
    })
    $.clock.every(TICK_MS, () => {
      $.ui.invalidate('ui.render')
      void keepWarmTick($, cfg, run)
    })
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await update($, limits, () => cleanLimits(e.rateLimits))
    if (e.changed.includes('cost') && e.cost) {
      const total = e.cost.usd
      await update($, sessionUsd, () => total)
    }
    if (e.changed.includes('context') && e.context.window) {
      const window = e.context.window
      await update($, facts, f => (f ? { ...f, window } : f))
    }
    return next(e)
  })

  // /clear and compaction start a new prefix; a resume or fork knows how long it was away and how big it is.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    ackedAt = 0
    if (e.source === 'clear') {
      await update($, facts, () => null)
      await update($, stats, () => EMPTY_STATS)
      await update($, engine, g => ({ ...g, switchedTo: null }))
    } else if (e.source === 'compact') {
      await update($, facts, () => null)
      await update($, engine, g => ({ ...g, switchedTo: null }))
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
    if (!e.agentId && !('skip' in r && r.skip)) await update($, facts, () => null)
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
    await update($, facts, () => ({ lastAt: startedAt, ctx: prompt + u.output_tokens, window, model, effort: e.effort ?? null }))
    await update($, engine, g => (g.switchedTo ? { ...g, switchedTo: null } : g))
    await update($, warm, w => ({ ...w, since: startedAt, streak: 0 }))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const u = await $.session.usage()
    if (u.context.window) {
      const window = u.context.window
      await update($, facts, f => (f && !f.window ? { ...f, window } : f))
    }
    return r
  })

  // A message sent into a cold cache re-writes the whole context. Held once, with the price; the resend goes through.
  on('prompt.submit', async ($, e, next) => {
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
    const text = `Cache Meter: ${why} This message re-writes ~${tok(view.ctx)} tokens on ${nameOf(view)}${price}.`
    if (guard === 'warn' || ackedAt === f.lastAt) {
      if (guard === 'warn') $.ui.log(text)
      ackedAt = 0
      return next(e)
    }
    ackedAt = f.lastAt
    return { drop: `${text} Send it again to go ahead, or /clear and start from a short summary.` }
  }).catch(($, e, next) => next(e)) // a meter that fails never blocks a message

  on('command.run', { command: 'cache' }, async ($, e) => {
    const [sub, arg] = (e.args ?? '').trim().toLowerCase().split(/\s+/)
    if (sub === 'warm') {
      const isOn = await setKeepWarm($, cfg, arg === 'on' ? true : arg === 'off' ? false : undefined)
      return { text: `Keep Warm is ${isOn ? 'on' : 'off'} for this session.` }
    }
    const opened = await openPane($)
    if (opened.isPlaced) return { text: 'Prompt Cache details are open in the side pane.' }
    const s = await snapshot($, cfg)
    return { text: summary(s.view, s.st, s.ls, s.ttl, s.now, s.total, s.warmOn, s.w, s.switched).join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest
    const { Box, Button, Text } = $.ui.resolve(e)
    const { view, st, ls, total, now, warmOn, switched } = await snapshot($, cfg)
    const tone = TONE[view.state]
    const cold = view.state === 'cold'

    const segs: Segment[] = []
    if (view.state === 'none') {
      segs.push({
        key: 'cache',
        prio: 0,
        pieces: [
          { t: '○', dim: true },
          { t: TITLE, bold: true },
          { t: st.requests ? 'Waiting for the next reply' : 'Waiting for the first reply', dim: true },
        ],
      })
    } else {
      segs.push({
        key: 'cache',
        prio: 0,
        pieces: [
          { t: '●', color: tone },
          { t: 'Cache', dim: true },
          { t: cold ? 'Cold' : 'Warm', color: tone, bold: true },
          switched
            ? { t: 'Model changed', dim: true }
            : cold
              ? { t: `Idle ${dur(view.idleMs)}`, dim: true }
              : { t: `${dur(view.leftMs)} left`, color: view.state === 'soon' ? tone : undefined },
          ...(warmOn && !cold ? [{ t: 'Kept Warm', dim: true }] : []),
        ],
      })
      // An unknown price is left out, never shown as a figure.
      if (cold && view.cold != null) {
        segs.push({ key: 'next', prio: 2, pieces: [{ t: 'Next', dim: true }, { t: usd(view.cold), color: 'error', bold: true }, { t: 'Re-cache', dim: true }] })
      } else if (!cold && view.warm != null) {
        segs.push({ key: 'next', prio: 2, pieces: [{ t: 'Next', dim: true }, { t: usd(view.warm), bold: true }] })
      }
      if (!cold && view.cold != null) segs.push({ key: 'cold', prio: 4, pieces: [{ t: 'If Cold', dim: true }, { t: usd(view.cold) }] })
      segs.push({
        key: 'ctx',
        prio: 3,
        pieces: [{ t: 'Context', dim: true }, { t: tok(view.ctx) }, ...(view.window ? [{ t: `${pct(view.ctx, view.window)}%`, dim: true }] : [])],
      })
    }
    const inputs = st.read + st.write + st.uncached
    if (st.requests > 0 && inputs > 0) segs.push({ key: 'hit', prio: 5, pieces: [{ t: 'Hit Rate', dim: true }, { t: `${pctDown(st.read, inputs)}%` }] })
    ls.forEach((l, i) => {
      const used = Math.round(l.percentUsed)
      const reset = resetIn(l.resetsAt, now)
      segs.push({
        key: `limit-${l.kind}`,
        // The plan's main limit stays in the band as long as the cache state does.
        prio: i === 0 ? 1 : 3,
        pieces:
          reset === 'now'
            ? [{ t: LIMIT_NAME[l.kind] ?? l.kind, dim: true }, { t: 'Just reset', dim: true }]
            : [
                { t: LIMIT_NAME[l.kind] ?? l.kind, dim: true },
                { t: `${used}%`, color: limitTone(used), bold: true },
                ...(reset ? [{ t: reset, dim: true }] : []),
              ],
      })
    })
    if (total != null && total > 0) segs.push({ key: 'usd', prio: 6, pieces: [{ t: 'Session', dim: true }, { t: usd(total) }] })

    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const DETAILS = 'Details'
    // The row's own padding takes a column each side.
    const { shown, withReserve } = fit(segs, columns - 2, DETAILS.length + 2)

    const row = (
      <Box key="cache-meter" flexDirection="row" paddingX={1}>
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
    const { Box, Button, Text } = $.ui.resolve(e)
    const { view, st, ls, ttl, now, total, w, warmOn, switched } = await snapshot($, cfg)
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
    const Row = (p: { k: string; label: string; children: RenderChildren }) => (
      <Box key={p.k} flexDirection="row" columnGap={1}>
        <Box width={LABEL} flexShrink={0}><Text dimColor wrap="truncate">{p.label}</Text></Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>{p.children}</Box>
      </Box>
    )
    /** A meter that fills its row: two boxes sized in percent, each clipping a long rule. */
    const Meter = (p: { share: number; color?: string }) => {
      const filled = Number.isFinite(p.share) ? Math.max(0, Math.min(100, Math.round(p.share * 100))) : 0
      return (
        <Box flexDirection="row" flexGrow={1} height={1} overflow="hidden">
          <Box width={`${filled}%`} flexShrink={0} overflow="hidden"><Text color={p.color} wrap="truncate">{'━'.repeat(300)}</Text></Box>
          <Box flexGrow={1} flexShrink={1} overflow="hidden"><Text dimColor wrap="truncate">{'─'.repeat(300)}</Text></Box>
        </Box>
      )
    }

    const cards: RenderChildren[] = []
    const effort = effortLabel(view.effort)

    cards.push(
      <Card k="cache" title={TITLE} note={<Text dimColor>{`TTL ${ttl}`}</Text>} first>
        {view.state === 'none' ? (
          <Row k="state" label="State"><Text dimColor>{st.requests ? 'Known after the next reply' : 'No request yet'}</Text></Row>
        ) : (
          [
            <Row k="state" label="State">
              <Text>
                <Text color={tone} bold>{cold ? 'Cold' : 'Warm'}</Text>
                <Text dimColor>
                  {switched
                    ? `${dot}Model changed, the next message writes the cache anew`
                    : cold
                      ? `${dot}Idle ${dur(view.idleMs)}`
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
      cards.push(
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
    cards.push(
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

    cards.push(
      <Card k="session" title="This Session" note={<Text dimColor>Main thread</Text>}>
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
      cards.push(
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

    cards.push(
      <Box key="foot" marginTop={1} paddingX={1}>
        <Text dimColor size="footnote">
          {ls.length > 0
            ? 'Dollar figures are API list prices. On a subscription they show how much of your limits a message takes, not a bill.'
            : 'Dollar figures are API list prices from the table in hooks/cache.ts.'}
        </Text>
      </Box>,
    )

    return <Box flexDirection="column">{cards}</Box>
  })
}

/** The pane's figures as plain lines, for a surface that cannot seat the pane. */
const summary = (
  v: CacheView, st: Stats, ls: readonly Limit[], ttl: Ttl, now: number, total: number | null, warmOn: boolean, w: KeepWarm, switched: string | null,
): string[] => {
  const out: string[] = []
  const line = (label: string, value: string) => out.push(`${label.padEnd(14)}${value}`)
  const effort = effortLabel(v.effort)
  if (v.state === 'none') line('Prompt Cache', st.requests ? 'Known after the next reply' : 'No request yet')
  else {
    const state = switched ? 'Cold, the model changed' : v.state === 'cold' ? `Cold, idle ${dur(v.idleMs)}` : `Warm, ${dur(v.leftMs)} left`
    line('Prompt Cache', `${state} (TTL ${ttl})`)
    line('Context', `${tok(v.ctx)} tokens${v.window ? `, ${pct(v.ctx, v.window)}% of ${tok(v.window)}` : ''}`)
    line('Model', `${nameOf(v)}${effort ? `, effort ${effort}` : ''}${v.price ? '' : ', not in the price table'}`)
    if (v.price) line('Next Message', `${usd(v.warm)} warm, ${usd(v.cold)} cold`)
  }
  line('Keep Warm', `${warmOn ? 'On' : 'Off'}, ${w.pings} pings (${usd(w.usd)}). /cache warm switches it.`)
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
