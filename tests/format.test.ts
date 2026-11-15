import { expect, test } from 'claude-code/testing'

import { GAP, SEP, fit, spaced, widthOf } from '../hooks/band'
import type { Segment } from '../hooks/band'
import {
  coldUsd, dur, effortLabel, limitTone, modelName, pct, pctDown, priceOf, requestUsd, resetIn, sortLimits, tok, usd, viewOf, warmUsd, writeRate,
} from '../hooks/cache'

const MIN = 60 * 1000
/** Floats compared to a millionth of a cent. */
const close = (got: number | null, want: number) => expect(got != null && Math.abs(got - want) < 1e-8).toBe(true)
const HOUR = 60 * MIN

test('tokens read as people count them, never 1000k', () => {
  expect(tok(0)).toBe('0')
  expect(tok(-5)).toBe('0')
  expect(tok(999)).toBe('999')
  expect(tok(1000)).toBe('1k')
  expect(tok(1499)).toBe('1k')
  expect(tok(1500)).toBe('2k')
  expect(tok(301_000)).toBe('301k')
  expect(tok(999_499)).toBe('999k')
  expect(tok(999_500)).toBe('1M')
  expect(tok(1_000_000)).toBe('1M')
  expect(tok(1_250_000)).toBe('1.3M')
  expect(tok(9_940_000)).toBe('9.9M')
  expect(tok(9_960_000)).toBe('10M')
  expect(tok(24_400_000)).toBe('24M')
})

test('dollars: cents, a floor under a cent, whole above $100, n/a when unknown', () => {
  expect(usd(null)).toBe('n/a')
  expect(usd(Number.NaN)).toBe('n/a')
  expect(usd(0)).toBe('$0.00')
  expect(usd(-1)).toBe('$0.00')
  expect(usd(0.004)).toBe('<$0.01')
  expect(usd(0.005)).toBe('$0.01')
  expect(usd(0.06)).toBe('$0.06')
  expect(usd(2.408)).toBe('$2.41')
  expect(usd(1.505)).toBe('$1.51')
  expect(usd(99.99)).toBe('$99.99')
  expect(usd(99.996)).toBe('$100')
  expect(usd(1234.5)).toBe('$1,235')
})

test('durations: seconds, minutes, hours with padded minutes, days with hours', () => {
  expect(dur(-1000)).toBe('0s')
  expect(dur(0)).toBe('0s')
  expect(dur(59_999)).toBe('59s')
  expect(dur(MIN)).toBe('1m')
  expect(dur(59 * MIN + 59_000)).toBe('59m')
  expect(dur(HOUR)).toBe('1h 00m')
  expect(dur(HOUR + 5 * MIN)).toBe('1h 05m')
  expect(dur(23 * HOUR + 59 * MIN)).toBe('23h 59m')
  expect(dur(24 * HOUR)).toBe('1d 0h')
  expect(dur(26 * HOUR + 30 * MIN)).toBe('1d 2h')
  for (const ms of [0, 1, 999, 61_000, HOUR, 25 * HOUR, 400 * HOUR]) {
    expect(dur(ms)).not.toContain('  ')
    expect(dur(ms)).toBe(dur(ms).trim())
  }
})

test('percents stay within 0 to 100, and a hit rate never rounds up to a whole it has not reached', () => {
  expect(pct(1, 0)).toBe(0)
  expect(pct(301_000, 1_000_000)).toBe(30)
  expect(pct(150, 100)).toBe(100)
  expect(pctDown(996, 1000)).toBe(99)
  expect(pctDown(1000, 1000)).toBe(100)
  expect(pctDown(580_000, 600_000)).toBe(96)
  expect(pctDown(1, 0)).toBe(0)
})

test('model ids map to the right price row and name, and unknown versions get no price', () => {
  const cases: Array<[string, string | null, number | null]> = [
    ['claude-opus-5-5', 'Opus 5.5', 4],
    ['claude-opus-5-5[1m]', 'Opus 5.5', 4],
    ['claude-opus-5', 'Opus 5', 5],
    ['claude-opus-4-5-20251101', 'Opus 4.5', 5],
    ['claude-opus-4-1-20250805', 'Opus 4.1', 15],
    ['claude-opus-4-20250514', 'Opus 4', 15],
    ['claude-fable-5-1', 'Fable 5.1', 10],
    ['claude-sonnet-5-5', 'Sonnet 5.5', 2],
    ['claude-sonnet-4-6', 'Sonnet 4.6', 3],
    ['claude-sonnet-4-5-20250929', 'Sonnet 4.5', 3],
    ['claude-3-7-sonnet-20250219', 'Sonnet 3.7', 3],
    ['claude-haiku-5-5', 'Haiku 5.5', 0.1],
    ['claude-haiku-4-5', 'Haiku 4.5', 1],
    ['claude-3-5-haiku-20241022', 'Haiku 3.5', 0.8],
    ['claude-3-haiku-20240307', 'Haiku 3', 0.25],
    ['us.anthropic.claude-opus-5-5-v1:0', 'Opus 5.5', 4],
    ['claude-opus-5-5@20261001', 'Opus 5.5', 4],
    // A version the table does not list is priced at nothing, never at a neighbour's price.
    ['claude-opus-5-1', null, null],
    ['claude-sonnet-5-7', null, null],
    ['gpt-5', null, null],
    ['', null, null],
  ]
  for (const [id, name, input] of cases) {
    const p = priceOf(id)
    expect([id, p?.input ?? null]).toEqual([id, input])
    if (name) expect([id, p?.name]).toEqual([id, name])
  }
  expect(modelName('claude-opus-5-1')).toBe('Opus 5.1')
  expect(modelName('claude-3-opus-20240229')).toBe('Opus 3')
  expect(modelName('gpt-5')).toBe(null)
  expect(priceOf(null)).toBe(null)
})

test('long prompts take the long-context price where the model has one', () => {
  expect(priceOf('claude-haiku-5-5', 100_000)?.input).toBe(0.1)
  expect(priceOf('claude-haiku-5-5', 100_001)?.input).toBe(0.5)
  expect(priceOf('claude-sonnet-4-5', 200_001)?.input).toBe(6)
  expect(priceOf('claude-opus-5-5', 900_000)?.input).toBe(4)
})

test('cache costs: read while warm, write at 1.25x (5m) or 2x (1h) once cold', () => {
  const p = priceOf('claude-opus-5-5')!
  expect(writeRate(p, '5m')).toBe(5)
  expect(writeRate(p, '1h')).toBe(8)
  close(warmUsd(p, 301_000), 0.0602)
  close(coldUsd(p, 301_000, '1h'), 2.408)
  close(coldUsd(p, 301_000, '5m'), 1.505)
  expect(warmUsd(null, 1)).toBe(null)
  close(requestUsd(p, { read: 1_000_000, write: 1_000_000, uncached: 1_000_000, output: 1_000_000 }, '1h'), 0.2 + 8 + 4 + 20)
  expect(requestUsd(null, { read: 1, write: 1, uncached: 1, output: 1 }, '1h')).toBe(null)
})

test('the cache view: none, warm, soon, cold at the exact edges', () => {
  const f = { lastAt: 1_000, ctx: 300_000, window: 1_000_000, model: 'claude-opus-5-5', effort: 'high' }
  expect(viewOf(null, 5_000, '1h').state).toBe('none')
  expect(viewOf({ ...f, lastAt: 0 }, 5_000, '1h').state).toBe('none')
  expect(viewOf({ ...f, ctx: 0 }, 5_000, '1h').state).toBe('none')
  expect(viewOf(f, 1_000, '1h')).toMatchObject({ state: 'warm', leftMs: HOUR, idleMs: 0 })
  expect(viewOf(f, 1_000 + 50 * MIN - 1, '1h').state).toBe('warm')
  expect(viewOf(f, 1_000 + 50 * MIN, '1h').state).toBe('soon')
  expect(viewOf(f, 1_000 + HOUR - 1, '1h').state).toBe('soon')
  expect(viewOf(f, 1_000 + HOUR, '1h')).toMatchObject({ state: 'cold', leftMs: 0 })
  expect(viewOf(f, 1_000 + 4 * MIN, '5m').state).toBe('soon')
  expect(viewOf(f, 1_000 + 5 * MIN, '5m').state).toBe('cold')
  // A clock that went backwards never shows more than a full TTL.
  expect(viewOf(f, 0, '1h').leftMs).toBe(HOUR)
  expect(viewOf({ ...f, model: 'gpt-5' }, 1_000, '1h')).toMatchObject({ price: null, warm: null, cold: null })
})

test('effort reads as a level or a budget', () => {
  expect(effortLabel(null)).toBe(null)
  expect(effortLabel('low')).toBe('Low')
  expect(effortLabel('medium')).toBe('Medium')
  expect(effortLabel('high')).toBe('High')
  expect(effortLabel('xhigh')).toBe('Extra High')
  expect(effortLabel('max')).toBe('Max')
  expect(effortLabel(32_000)).toBe('32k budget')
})

test('limits: order, tone and the reset countdown', () => {
  const now = Date.parse('2026-10-31T00:00:00Z')
  expect(sortLimits([{ kind: 'seven_day' }, { kind: 'other' }, { kind: 'five_hour' }]).map(l => l.kind)).toEqual(['five_hour', 'seven_day', 'other'])
  expect(limitTone(79)).toBe(undefined)
  expect(limitTone(80)).toBe('warning')
  expect(limitTone(94)).toBe('warning')
  expect(limitTone(95)).toBe('error')
  expect(resetIn(undefined, now)).toBe('')
  expect(resetIn('not a date', now)).toBe('')
  expect(resetIn('2026-10-30T23:00:00Z', now)).toBe('now')
  expect(resetIn('2026-11-01T01:30:00Z', now)).toBe('1d 1h')
  expect(resetIn('2026-10-31T00:45:00Z', now)).toBe('45m')
})

const seg = (key: string, prio: number, ...texts: string[]): Segment => ({ key, prio, pieces: texts.map(t => ({ t })) })

test('the band joins pieces with one space and parts with the separator, nothing doubled', () => {
  const pieces = spaced([{ t: 'Weekly' }, { t: '13%' }, { t: '1d 1h' }])
  expect(pieces.map(p => p.t).join('')).toBe('Weekly 13% 1d 1h')
  expect(pieces.filter(p => p.t === GAP).length).toBe(2)
  expect(widthOf(seg('a', 0, 'Weekly', '13%', '1d 1h'))).toBe('Weekly 13% 1d 1h'.length)
  expect(widthOf(seg('a', 0))).toBe(0)
  expect(SEP.trim()).toBe('│')
})

test('the band keeps parts by priority, in reading order, and never drops the first', () => {
  const segs = [seg('cache', 0, '●', 'Cache', 'Warm', '46m left'), seg('next', 2, 'Next', '$0.06'), seg('limit', 1, 'Weekly', '13%', '1d 1h'), seg('hit', 5, 'Hit Rate', '99%')]
  const wide = fit(segs, 200, 9)
  expect(wide.shown.map(s => s.key)).toEqual(['cache', 'next', 'limit', 'hit'])
  expect(wide.withReserve).toBe(true)
  const cacheW = widthOf(segs[0]!)
  const limitW = widthOf(segs[2]!) + SEP.length
  const mid = fit(segs, cacheW + limitW + 9, 9)
  expect(mid.shown.map(s => s.key)).toEqual(['cache', 'limit'])
  // Too narrow for the cache state beside Details: the state stays, Details goes.
  const tight = fit(segs, cacheW + 2, 9)
  expect(tight.shown.map(s => s.key)).toEqual(['cache'])
  expect(tight.withReserve).toBe(false)
  // Narrower than anything: the state is still drawn, the surface clips it.
  expect(fit(segs, 3, 9).shown.map(s => s.key)).toEqual(['cache'])
  expect(fit([], 100, 9).shown).toEqual([])
})

test('Fable 5.2 and Mythos 5.2 have their own prices, Sonnet 5.5 its cache read', () => {
  expect(priceOf('claude-fable-5-2')).toMatchObject({ name: 'Fable 5.2', input: 8, output: 40, read: 0.2 })
  expect(priceOf('claude-mythos-5-2[1m]')).toMatchObject({ input: 8, output: 40, read: 0.2 })
  expect(priceOf('claude-fable-5-1')?.input).toBe(10)
  expect(priceOf('claude-sonnet-5-5')?.read).toBe(0.1)
})

test('a band too narrow for every part says them shorter before dropping one', () => {
  const p = (t: string) => ({ t })
  const segs: Segment[] = [
    { key: 'cache', prio: 0, pieces: [p('Cache'), p('Warm')] },
    { key: '7d', prio: 1, pieces: [p('Weekly'), p('24%'), p('6d 7h')], short: [p('Weekly'), p('24%')] },
    { key: 'context', prio: 1, pieces: [p('Context'), p('136k'), p('14%')], short: [p('Context'), p('14%')] },
  ]
  const wide = fit(segs, 80, 0)
  expect(wide.shown.map(s => widthOf(s))).toEqual(segs.map(s => widthOf(s)))
  const tight = fit(segs, 44, 0)
  expect(tight.shown.map(s => s.key)).toEqual(['cache', '7d', 'context'])
  expect(tight.shown[2]!.pieces.map(x => x.t)).toEqual(['Context', '14%'])
})
