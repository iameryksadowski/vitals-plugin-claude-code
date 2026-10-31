import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { CacheFacts, Limit, Stats } from '../types'
import {
  COLD_WRITE_MIN, COLD_WRITE_SHARE, GUARD_MIN_TOKENS, LIMIT_NAME, TONE, TTL_MS,
  bar, dur, limitTone, pct, priceOf, requestUsd, resetIn, sortLimits, tok, usd, viewOf,
} from './cache'
import type { CacheView, Ttl } from './cache'

// A quiet meter above the prompt: whether the prompt cache is warm or cold,
// how long it has left, how big the context is, what the next message costs
// warm and cold, the session's cache hit rate and the 5h / 7d usage windows.
// /cache opens a pane with the full breakdown. It never calls a model: every
// figure is the engine's own or the API's usage, priced from a list table.

const PANE = 'cache-meter'
/** How often the band redraws, so the countdown and the warm-to-cold flip stay current. */
const TICK_MS = 15_000

const EMPTY_STATS: Stats = { requests: 0, read: 0, write: 0, uncached: 0, output: 0, savedUsd: 0, coldWrites: 0, coldUsd: 0, last: null }

const facts = atom({ plugin: 'cache-meter', key: 'facts' } as const, null as CacheFacts | null, { shape: 'facts-1' })
const limits = atom({ plugin: 'cache-meter', key: 'limits' } as const, [] as Limit[], { shape: 'limits-1' })
const stats = atom({ plugin: 'cache-meter', key: 'stats' } as const, EMPTY_STATS, { shape: 'stats-1' })
const sessionUsd = atom({ plugin: 'cache-meter', key: 'sessionUsd' } as const, null as number | null, { shape: 'usd-1' })

const cleanLimits = (list: readonly Limit[]): Limit[] =>
  sortLimits(list.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })))

/** One run of text in the band. */
type Piece = { t: string; color?: string; dim?: boolean; bold?: boolean }
/** One part of the band; the lower `prio`, the longer it stays as the band narrows. */
type Segment = { key: string; prio: number; pieces: Piece[] }

const SEP = ' · '
const widthOf = (s: Segment): number => s.pieces.reduce((n, p) => n + p.t.length, 0)

/** The parts that fit in `columns`, kept in their reading order. */
const fit = (segs: Segment[], columns: number, reserve: number): Segment[] => {
  const keep = new Set<string>()
  let used = reserve
  for (const s of [...segs].sort((a, b) => a.prio - b.prio)) {
    const w = widthOf(s) + (keep.size ? SEP.length : 0)
    if (used + w > columns) continue
    keep.add(s.key)
    used += w
  }
  return segs.filter(s => keep.has(s.key))
}

type TtlOption = Ttl | 'auto'

/** auto: a subscription reports usage windows and caches for an hour; an API key caches for 5 minutes. */
const resolveTtl = (option: TtlOption, ls: readonly Limit[]): Ttl => (option === 'auto' ? (ls.length > 0 ? '1h' : '5m') : option)

/** Everything the band, the pane and the guard read, at one moment. */
async function snapshot($: EngineInterface, option: TtlOption) {
  const ls = await read($, limits)
  const ttl = resolveTtl(option, ls)
  const now = await $.clock.now()
  return { ls, ttl, now, view: viewOf(await read($, facts), now, ttl), st: await read($, stats), total: await read($, sessionUsd) }
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Prompt cache' })
}

export const register: Register = (on, options) => {
  const ttlOption: TtlOption = options.ttl === '1h' || options.ttl === '5m' ? options.ttl : 'auto'
  const guard = options.guard === 'warn' || options.guard === 'off' ? options.guard : 'confirm'
  /** The cold send the person was already told about: its resend goes through. */
  let ackedAt = 0

  const ttlOf = (ls: readonly Limit[]): Ttl => resolveTtl(ttlOption, ls)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const u = await $.session.usage()
    await update($, limits, () => cleanLimits(u.rateLimits))
    await update($, sessionUsd, () => u.cost?.usd ?? null)
    await $.command.register({ name: 'cache', description: 'Prompt cache: state, context, warm and cold cost, hit rate, usage windows (cache-meter)' })
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
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
    } else if (e.source === 'compact') {
      await update($, facts, () => null)
    } else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const now = await $.clock.now()
      const u = await $.session.usage()
      const lastAt = now - e.seconds_since_last_response * 1000
      const ctx = typeof e.context_tokens === 'number' ? e.context_tokens : (u.context.tokens ?? 0)
      const model = typeof e.model === 'string' ? e.model : await $.session.model()
      await update($, facts, () => ({ lastAt, ctx, window: u.context.window, model }))
    }
    return r
  }).catch(($, e, next) => next(e)) // a meter that fails to seed never holds up the session

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    // The summary is the next request's whole prefix: writing it is no cold write.
    if (!e.agentId && !('skip' in r && r.skip)) await update($, facts, () => null)
    return r
  }).catch(($, e, next) => next(e)) // a failed reset never holds up a compaction

  // Each main-thread request reads or writes the cache, and its start resets the TTL.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const startedAt = await $.clock.now()
    const r = yield* next(e)
    const u = r.usage
    if (!u) return r
    const model = u.model || e.model
    const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    const price = priceOf(model, prompt)
    const ttl = ttlOf(await read($, limits))
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
      coldUsd: s.coldUsd + (isColdWrite && price ? (write * (price.input * (ttl === '1h' ? 2 : 1.25))) / 1e6 : 0),
      last: { at: startedAt, ...req, model, usd: cost },
    }))
    // The next request re-sends this prompt and this answer.
    await update($, facts, f => ({ lastAt: startedAt, ctx: prompt + u.output_tokens, window: f?.window ?? 0, model }))
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
    const { view, ttl } = await snapshot($, ttlOption)
    if (!f || view.state !== 'cold' || view.ctx < GUARD_MIN_TOKENS) return next(e)
    const name = view.price?.name ?? view.model ?? 'this model'
    const text =
      `prompt cache went cold ${dur(view.idleMs - TTL_MS[ttl])} ago. This message re-writes ~${tok(view.ctx)} tokens on ${name}: ` +
      `${usd(view.cold)} (warm it would read them for ${usd(view.warm)}).`
    if (guard === 'warn' || ackedAt === f.lastAt) {
      if (guard === 'warn') $.ui.log(`cache-meter: ${text}`)
      ackedAt = 0
      return next(e)
    }
    ackedAt = f.lastAt
    return { drop: `cache-meter: ${text} Send it again to go ahead, or /clear and start from a short summary.` }
  }).catch(($, e, next) => next(e)) // a meter that fails never blocks a message

  on('command.run', { command: 'cache' }, async $ => {
    const opened = await openPane($)
    if (opened.isPlaced) return { text: 'Prompt cache details are open in the side pane.' }
    const { view, st, ls, ttl, now, total } = await snapshot($, ttlOption)
    return { text: summary(view, st, ls, ttl, now, total).join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest
    const { Box, Button, Text } = $.ui.resolve(e)
    const { view, st, ls, total } = await snapshot($, ttlOption)
    const now = await $.clock.now()
    const tone = TONE[view.state]

    const segs: Segment[] = []
    if (view.state === 'none') {
      segs.push({ key: 'cache', prio: 0, pieces: [{ t: '○ cache', dim: true }, { t: ' waiting for the first reply', dim: true }] })
    } else {
      const cold = view.state === 'cold'
      segs.push({
        key: 'cache',
        prio: 0,
        pieces: [
          { t: '● ', color: tone },
          { t: 'cache ', dim: true },
          { t: cold ? 'cold' : 'warm', color: tone, bold: true },
          cold ? { t: ` ${dur(view.idleMs)} idle`, dim: true } : { t: ` ${dur(view.leftMs)} left`, color: view.state === 'soon' ? tone : undefined },
        ],
      })
      segs.push(
        cold
          ? { key: 'next', prio: 1, pieces: [{ t: 'next ', dim: true }, { t: usd(view.cold), color: 'error', bold: true }, { t: ' re-cache', dim: true }] }
          : { key: 'next', prio: 1, pieces: [{ t: 'next ', dim: true }, { t: usd(view.warm) }] },
      )
      segs.push({
        key: 'ctx',
        prio: 2,
        pieces: [{ t: 'ctx ', dim: true }, { t: tok(view.ctx) }, ...(view.window ? [{ t: ` ${pct(view.ctx, view.window)}%`, dim: true }] : [])],
      })
      if (!cold) segs.push({ key: 'cold', prio: 4, pieces: [{ t: 'cold ', dim: true }, { t: usd(view.cold), dim: true }] })
    }
    const inputs = st.read + st.write + st.uncached
    if (st.requests > 0) segs.push({ key: 'hit', prio: 5, pieces: [{ t: 'hit ', dim: true }, { t: `${pct(st.read, inputs)}%` }] })
    ls.forEach((w, i) => {
      const used = Math.round(w.percentUsed)
      const reset = resetIn(w.resetsAt, now)
      segs.push({
        key: `limit-${w.kind}`,
        prio: i === 0 ? 2 : 3,
        pieces: [
          { t: `${LIMIT_NAME[w.kind] ?? w.kind} `, dim: true },
          { t: `${used}%`, color: limitTone(used), bold: limitTone(used) !== undefined },
          ...(reset ? [{ t: ` ${reset}`, dim: true }] : []),
        ],
      })
    })
    if (total != null && total > 0) segs.push({ key: 'usd', prio: 6, pieces: [{ t: 'session ', dim: true }, { t: usd(total) }] })

    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const DETAILS = 'details'
    const shown = fit(segs, columns - 2, DETAILS.length + SEP.length)

    const row = (
      <Box key="cache-meter" flexDirection="row" paddingX={1}>
        {shown.map((s, i) => (
          <Box key={s.key} flexDirection="row" flexShrink={0}>
            {i > 0 ? <Text dimColor>{SEP}</Text> : null}
            {s.pieces.map(p => (
              <Text color={p.color} dimColor={p.dim} bold={p.bold}>{p.t}</Text>
            ))}
          </Box>
        ))}
        <Box key="grow" flexGrow={1} />
        <Button key="details" label={DETAILS} plain dimColor onPress={() => void openPane($)} />
      </Box>
    )
    return rest ? <Box flexDirection="column">{rest}{row}</Box> : row
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { view, st, ls, ttl, now, total } = await snapshot($, ttlOption)
    const columns = e.props.bodyColumns ?? 48
    const cells = Math.max(10, Math.min(28, columns - 22))
    const tone = TONE[view.state]
    const LABEL = 14

    const Row = (p: { k: string; label: string; children: RenderChildren }) => (
      <Box key={p.k} flexDirection="row">
        <Box width={LABEL} flexShrink={0}><Text dimColor>{p.label}</Text></Box>
        <Box flexDirection="row" flexShrink={1}>{p.children}</Box>
      </Box>
    )
    const Heading = (p: { k: string; t: string }) => (
      <Box key={p.k} marginTop={1}><Text bold>{p.t}</Text></Box>
    )
    const Bar = (p: { share: number; color?: string }) => {
      const b = bar(p.share, cells)
      return [<Text color={p.color}>{b.on}</Text>, <Text dimColor>{b.off}</Text>]
    }

    const inputs = st.read + st.write + st.uncached
    const cold = view.state === 'cold'
    const rows: RenderChildren[] = []

    rows.push(<Box key="h-cache"><Text bold>Prompt cache</Text><Text dimColor>{`  TTL ${ttl}`}</Text></Box>)
    if (view.state === 'none') {
      rows.push(<Row k="state" label="state"><Text dimColor>no request yet</Text></Row>)
    } else {
      rows.push(
        <Row k="state" label="state">
          <Text color={tone} bold>{cold ? 'cold' : 'warm'}</Text>
          <Text dimColor>{cold ? `  ${dur(view.idleMs)} since the last request` : `  ${dur(view.leftMs)} left, idle ${dur(view.idleMs)}`}</Text>
        </Row>,
      )
      rows.push(<Row k="ttl" label="">{Bar({ share: cold ? 0 : view.leftMs / TTL_MS[ttl], color: tone })}</Row>)
      rows.push(<Row k="model" label="model"><Text>{view.price?.name ?? view.model ?? 'unknown'}</Text>{view.price ? null : <Text dimColor>  not in the price table</Text>}</Row>)
      rows.push(
        <Row k="ctx" label="context">
          <Text>{`${tok(view.ctx)} tokens`}</Text>
          {view.window ? <Text dimColor>{`  ${pct(view.ctx, view.window)}% of ${tok(view.window)}`}</Text> : null}
        </Row>,
      )
      if (view.window) rows.push(<Row k="ctx-bar" label="">{Bar({ share: view.ctx / view.window })}</Row>)

      rows.push(<Heading k="h-next" t="Next message re-sends the context" />)
      rows.push(
        <Row k="warm" label="while warm">
          <Text bold={!cold} color={cold ? undefined : 'success'}>{usd(view.warm)}</Text>
          <Text dimColor>{view.price ? `  read at $${view.price.read}/MTok` : ''}</Text>
        </Row>,
      )
      rows.push(
        <Row k="cold" label="once cold">
          <Text bold={cold} color={cold ? 'error' : undefined}>{usd(view.cold)}</Text>
          <Text dimColor>{view.price ? `  write at $${view.price.input * (ttl === '1h' ? 2 : 1.25)}/MTok` : ''}</Text>
        </Row>,
      )
      if (view.warm && view.cold) rows.push(<Row k="ratio" label="cold / warm"><Text>{`${Math.round(view.cold / view.warm)}x`}</Text></Row>)
    }

    rows.push(<Heading k="h-session" t="This session (main thread)" />)
    if (st.requests === 0) {
      rows.push(<Row k="none" label="requests"><Text dimColor>none yet</Text></Row>)
    } else {
      rows.push(<Row k="req" label="requests"><Text>{String(st.requests)}</Text></Row>)
      rows.push(
        <Row k="hit" label="cache hit">
          <Text bold>{`${pct(st.read, inputs)}%`}</Text>
          <Text dimColor>{`  ${tok(st.read)} read · ${tok(st.write)} written · ${tok(st.uncached)} uncached`}</Text>
        </Row>,
      )
      rows.push(<Row k="hit-bar" label="">{Bar({ share: inputs ? st.read / inputs : 0, color: 'success' })}</Row>)
      rows.push(<Row k="saved" label="cache saved"><Text color="success">{usd(st.savedUsd)}</Text><Text dimColor>  vs full input price</Text></Row>)
      rows.push(
        <Row k="cold-writes" label="cold writes">
          <Text color={st.coldWrites ? 'warning' : undefined}>{String(st.coldWrites)}</Text>
          {st.coldWrites ? <Text dimColor>{`  ${usd(st.coldUsd)} re-caching`}</Text> : null}
        </Row>,
      )
      if (st.last) {
        const l = st.last
        rows.push(
          <Row k="last" label="last request">
            <Text>{usd(l.usd)}</Text>
            <Text dimColor>{`  ${dur(now - l.at)} ago · ${tok(l.read)} read · ${tok(l.write)} written · ${tok(l.uncached)} new · ${tok(l.output)} out`}</Text>
          </Row>,
        )
      }
    }
    if (total != null) rows.push(<Row k="total" label="session total"><Text>{usd(total)}</Text><Text dimColor>  all requests, subagents too</Text></Row>)

    if (ls.length > 0) {
      rows.push(<Heading k="h-limits" t="Usage windows" />)
      for (const w of ls) {
        const used = Math.round(w.percentUsed)
        const reset = resetIn(w.resetsAt, now)
        rows.push(
          <Row k={`l-${w.kind}`} label={LIMIT_NAME[w.kind] ?? w.kind}>
            {Bar({ share: used / 100, color: limitTone(used) })}
            <Text color={limitTone(used)} bold>{`  ${used}%`}</Text>
            {reset ? <Text dimColor>{`  resets in ${reset}`}</Text> : null}
          </Row>,
        )
      }
    }

    rows.push(
      <Box key="foot" marginTop={1}>
        <Text dimColor>
          {ls.length > 0
            ? 'Dollar figures are API list prices. On a subscription they are a yardstick for how much of your limits a message takes, not a bill.'
            : 'Dollar figures are API list prices from the table in hooks/cache.ts.'}
        </Text>
      </Box>,
    )

    return <Box flexDirection="column">{rows}</Box>
  })
}

/** The pane's figures as plain lines, for a surface that cannot seat the pane. */
const summary = (v: CacheView, st: Stats, ls: readonly Limit[], ttl: Ttl, now: number, total: number | null): string[] => {
  const out: string[] = []
  if (v.state === 'none') out.push('cache        no request yet')
  else {
    out.push(`cache        ${v.state === 'cold' ? `cold, ${dur(v.idleMs)} idle` : `warm, ${dur(v.leftMs)} left`} (TTL ${ttl})`)
    out.push(`context      ${tok(v.ctx)} tokens${v.window ? `, ${pct(v.ctx, v.window)}% of ${tok(v.window)}` : ''} on ${v.price?.name ?? v.model ?? 'unknown model'}`)
    out.push(`next msg     ${usd(v.warm)} warm, ${usd(v.cold)} cold`)
  }
  const inputs = st.read + st.write + st.uncached
  if (st.requests) out.push(`cache hit    ${pct(st.read, inputs)}% over ${st.requests} requests, saved ${usd(st.savedUsd)}, ${st.coldWrites} cold writes (${usd(st.coldUsd)})`)
  if (total != null) out.push(`session      ${usd(total)}`)
  for (const w of ls) out.push(`${(LIMIT_NAME[w.kind] ?? w.kind).padEnd(13)}${Math.round(w.percentUsed)}% used${w.resetsAt ? `, resets in ${resetIn(w.resetsAt, now)}` : ''}`)
  return out
}
