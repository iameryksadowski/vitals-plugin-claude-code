import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { SEP } from '../hooks/band'

type $T = Parameters<TestBody>[0]
type LimitIn = { kind: string; percentUsed: number; resetsAt?: string }
type Usage = { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

const NOW = Date.parse('2026-10-31T00:00:00Z')
const MIN = 60 * 1000
const HOUR = 60 * MIN

const bandProps = (bodyColumns = 200, hasSurvey = false) =>
  ({ hasSurvey, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns, scroll: { offset: 0, bodyRows: 4 }, view: {} }) as const
const band = (bodyColumns?: number, hasSurvey?: boolean) =>
  ({ plugin: 'cache-meter', component: 'AbovePrompt', props: bandProps(bodyColumns, hasSurvey) }) as const
const pane = (bodyColumns = 60) =>
  ({
    plugin: 'cache-meter',
    component: 'Pane',
    requestId: 'cache-meter',
    props: { title: 'Prompt Cache', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  }) as const

const FIVE_HOUR: LimitIn = { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-31T03:10:00Z' }
const WEEKLY: LimitIn = { kind: 'seven_day', percentUsed: 88, resetsAt: '2026-11-02T04:00:00Z' }

/** One 301k-token Opus 5.5 request: 290k read, 8k written, 2k new, 1k out. */
const OPUS: Usage = { model: 'claude-opus-5-5', input_tokens: 2_000, output_tokens: 1_000, cache_read_input_tokens: 290_000, cache_creation_input_tokens: 8_000 }

type Fork = { isAnswered: true; text: string; usage: Omit<Usage, 'model'> } | { isAnswered: false; reason: 'nothing-to-fork' } | { isAnswered: false; reason: 'api-error'; status: number; error: 'overloaded'; usage: Omit<Usage, 'model'> }
const FORK_HIT: Fork = { isAnswered: true, text: 'OK', usage: { input_tokens: 30, output_tokens: 2, cache_read_input_tokens: 301_000, cache_creation_input_tokens: 0 } }
const FORK_MISS: Fork = { isAnswered: true, text: 'OK', usage: { input_tokens: 30, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 301_000 } }

type World = {
  limits?: LimitIn[]
  usage?: Usage
  cost?: number | null
  fork?: Fork
  placed?: boolean
  engineRow?: boolean
  root?: string
  store?: Record<string, unknown>
}

/** The engine beneath the plugin, with counters a test reads back. */
const engine = (on: On, w: World = {}) => {
  const seen = { forks: 0, logs: [] as string[], toasts: [] as string[] }
  const store = new Map<string, unknown>(Object.entries(w.store ?? {}))
  on('store.get', (_, e) => ({ value: store.get((e as { key: string }).key) }))
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete((e as { key: string }).key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  const state = { usage: w.usage ?? OPUS, limits: w.limits ?? [FIVE_HOUR, WEEKLY], fork: w.fork ?? FORK_HIT, root: w.root ?? '/work/app' }
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 300_000, window: 1_000_000, percent: 30 },
      rateLimits: state.limits,
      cost: w.cost === null ? undefined : { usd: w.cost ?? 3.5 },
    },
  }))
  on('session.model', () => ({ value: state.usage.model }))
  on('session.root', () => ({ value: state.root }))
  on('command.register', () => ({ value: { command: 'cache' } }))
  on('ui.open', () => ({ value: w.placed === false ? { isPlaced: false as const, reason: 'no room for a pane' } : { isPlaced: true as const } }))
  on('ui.log', (_, e) => {
    seen.logs.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return w.engineRow ? <Text>engine row</Text> : <Box />
  })
  on('model.fork', () => {
    seen.forks += 1
    return { value: state.fork }
  })
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: state.usage }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  return { seen, state, store }
}

const start = async ($: $T) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

const step = async ($: $T, extra: { agentId?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number } = {}) => {
  const run = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: extra.effort ?? 'xhigh', messageCount: 10, ...(extra.agentId ? { agentId: extra.agentId } : {}) })
  for await (const _ of run) void _
}

/** /cache as typed, with whatever follows it. */
const cache = async ($: $T, args = '') => ((await $.command.run({ command: 'cache', args } as never)) as { text?: string }).text ?? ''

const send = ($: $T, text: string, kind = 'composer') => $.prompt.submit({ text, origin: { kind } as never, wait: false })

/** The band as one line of text, as a person reads it. */
const bandLine = async ($: $T, columns = 200, surface: 'terminal' | 'desktop' = 'desktop') => {
  const ui = await $.ui.mount({ ...band(columns), surface })
  const texts = await ui.findAll({ type: 'Text' })
  const details = await ui.find({ type: 'Button' })
  await ui.unmount()
  return { line: texts.map(t => t.text).join(''), texts, hasDetails: details !== undefined }
}

/** No doubled or stray spaces anywhere: one between pieces, the separator between parts. */
const expectTidy = (line: string) => {
  for (const part of line.split(SEP)) {
    expect([line, part]).toEqual([line, part.trim()])
    expect([line, part.includes('  ')]).toEqual([line, false])
    expect([line, part.length > 0]).toEqual([line, true])
  }
}

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<Array<{ text: string }>> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

const switchModel = ($: $T, to: string, from = 'claude-opus-5-5', ttl: '5m' | '1h' = '1h') =>
  $.classic.PostModelSwitch({
    from_model: from,
    to_model: to,
    requested_model: to,
    source: 'command',
    context_tokens: 301_000,
    prompt_cache_warm: true,
    cache_ttl: ttl,
    estimated_cache_write_usd: 1,
    pricing: 'catalog',
  } as never)

// ── The band ────────────────────────────────────────────────────────────────

test('before the first reply the band waits, tidy, with no figures it does not have', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const { line, hasDetails } = await bandLine($, 200, surface)
    expectTidy(line)
    expect(line.startsWith('○ Prompt Cache Waiting for the first reply')).toBe(true)
    // The limits and the session cost are known before any reply; the cache figures are not.
    for (const none of ['Hit Rate', 'Next', 'If Cold', 'Context']) expect(line).not.toContain(none)
    expect(line).toContain('Weekly 88% 2d 4h')
    expect(hasDetails).toBe(true)
  }
})

test('a warm cache reads exactly as expected, in reading order', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  const { line } = await bandLine($)
  expectTidy(line)
  expect(line).toBe(
    [
      '● Cache Warm 1h 00m left',
      'Next $0.06',
      'If Cold $2.41',
      'Context 301k 30%',
      'Hit Rate 96%',
      '5-Hour 42% 3h 10m',
      'Weekly 88% 2d 4h',
      'Session $3.50',
    ].join(SEP),
  )
})

test('at every width the band stays tidy, fits, and keeps the cache state and the main limit longest', async ($, on) => {
  engine(on, { limits: [WEEKLY] })
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  for (let columns = 10; columns <= 220; columns += 5) {
    const { line, hasDetails } = await bandLine($, columns)
    expectTidy(line)
    expect([columns, line.includes('Cache Warm')]).toEqual([columns, true])
    const parts = line.split(SEP).length
    // Room for the parts, the row's padding and Details beside them.
    if (parts > 1) expect([columns, line.length + 2 + (hasDetails ? 9 : 0) <= columns]).toEqual([columns, true])
    // The weekly limit goes only after everything but the state is gone.
    if (line.includes('Next') || line.includes('Context')) expect([columns, line.includes('Weekly 88% 2d 4h')]).toEqual([columns, true])
  }
})

test('a plan with the weekly limit alone shows Weekly and no 5-hour limit, and caches for an hour', async ($, on) => {
  engine(on, { limits: [{ kind: 'five_hour', percentUsed: 0 }, WEEKLY] })
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  const { line } = await bandLine($)
  expect(line).toContain('Weekly 88% 2d 4h')
  expect(line).not.toContain('5-Hour')
  expect(line).toContain('1h 00m left')
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Weekly' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '5-Hour' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'TTL 1h' })).toBeDefined()
  await ui.unmount()
})

test('an API key with no limits caches for 5 minutes and shows no limit', async ($, on) => {
  engine(on, { limits: [], cost: 0.42 })
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  let { line } = await bandLine($)
  expect(line).toContain('Warm 5m left')
  expect(line).toContain('If Cold $1.51')
  expect(line).not.toContain('Weekly')
  await clock.advance(5 * MIN)
  ;({ line } = await bandLine($))
  expect(line).toContain('Cold Idle 5m')
})

test('the ttl setting wins over the guess', { options: { ttl: '5m' } }, async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  expect((await bandLine($)).line).toContain('Warm 5m left')
})

test('the TTL the engine reports wins over the guess', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await switchModel($, 'claude-opus-5-5', 'claude-opus-5-5', '5m')
  expect((await bandLine($)).line).toContain('Warm 5m left')
})

test('in the last ten minutes the countdown turns to a warning', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(51 * MIN)
  const ui = await $.ui.mount({ ...band(), surface: 'desktop' })
  const left = await ui.find({ type: 'Text', text: '9m left' })
  expect(left?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Text', text: 'Warm' }))?.props.color).toBe('warning')
  await ui.unmount()
})

test('a cold cache shows the idle time and the re-cache price, and no warm figures', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(HOUR + 5 * MIN)
  const { line } = await bandLine($)
  expectTidy(line)
  expect(line).toContain('● Cache Cold Idle 1h 05m')
  expect(line).toContain('Next $2.41 Re-cache')
  expect(line).not.toContain('If Cold')
  expect(line).not.toContain('left')
})

test('a model switch makes the cache cold at once, priced on the new model, until its first reply', { options: { guard: 'confirm' } }, async ($, on) => {
  const { state } = engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await switchModel($, 'claude-sonnet-5-5')
  let { line } = await bandLine($)
  expect(line).toContain('Cache Cold Model changed')
  // 301k written on Sonnet 5.5 at the 1h rate, $4/MTok.
  expect(line).toContain('Next $1.20 Re-cache')
  const held = await send($, 'go on')
  expect(held.drop).toContain('The model changed to Sonnet 5.5')
  expect(held.drop).not.toContain('a warm read')
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Sonnet 5.5' })).toBeDefined()
  await ui.unmount()

  state.usage = { ...OPUS, model: 'claude-sonnet-5-5' }
  await step($)
  ;({ line } = await bandLine($))
  expect(line).toContain('Cache Warm 1h 00m left')
})

test('a switch to the same model changes nothing', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await switchModel($, 'claude-opus-5-5')
  expect((await bandLine($)).line).toContain('Cache Warm')
})

test('a model the price table does not know shows no prices, never n/a, and is named from its id', { options: { guard: 'confirm' } }, async ($, on) => {
  engine(on, { usage: { ...OPUS, model: 'claude-opus-5-1' } })
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  const { line } = await bandLine($)
  expectTidy(line)
  expect(line).not.toContain('Next')
  expect(line).not.toContain('If Cold')
  expect(line).not.toContain('n/a')
  expect(line).toContain('Context 301k 30%')
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Opus 5.1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Not in the price table/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Next Message' })).toBeUndefined()
  await ui.unmount()
  await clock.advance(2 * HOUR)
  const held = await send($, 'hi')
  expect(held.drop).toContain('re-writes ~301k tokens on Opus 5.1.')
  expect(held.drop).not.toContain('$')
})

test('subagent requests never touch the main thread figures', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($, { agentId: 'a1' })
  const { line } = await bandLine($)
  expect(line).toContain('Waiting for the first reply')
  expect(line).not.toContain('Hit Rate')
})

test('/clear starts over: no state, no session figures', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await $.classic.SessionStart({ source: 'clear' } as never)
  const { line } = await bandLine($)
  expect(line).toContain('Waiting for the first reply')
  expect(line).not.toContain('Hit Rate')
})

test('after compaction the state waits for the next reply and the session figures stay', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await $.classic.SessionStart({ source: 'compact' } as never)
  const { line } = await bandLine($)
  expect(line).toContain('Waiting for the next reply')
  expect(line).toContain('Hit Rate 96%')
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Known after the next reply' })).toBeDefined()
  await ui.unmount()
})

test('a resumed session knows how long it was away', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 120, context_tokens: 301_000, model: 'claude-opus-5-5' } as never)
  expect((await bandLine($)).line).toContain('Cache Warm 58m left')
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 4_000, context_tokens: 301_000, model: 'claude-opus-5-5' } as never)
  expect((await bandLine($)).line).toContain('Cache Cold Idle 1h 06m')
})

test('a limit past its reset says so instead of showing the old figure', async ($, on) => {
  engine(on, { limits: [{ kind: 'seven_day', percentUsed: 97, resetsAt: '2026-10-30T23:00:00Z' }] })
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  const { line } = await bandLine($)
  expect(line).toContain('Weekly Just reset')
  expect(line).not.toContain('97%')
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Just reset/ })).toBeDefined()
  await ui.unmount()
})

test('limits are calm under 80%, a warning to 95%, then an error', async ($, on) => {
  engine(on, { limits: [{ kind: 'seven_day', percentUsed: 97, resetsAt: '2026-11-02T04:00:00Z' }] })
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  const ui = await $.ui.mount({ ...band(), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: '97%' }))?.props.color).toBe('error')
  await ui.unmount()
})

test('a limit with a bad figure is left out rather than drawn wrong', async ($, on) => {
  engine(on, { limits: [{ kind: 'seven_day', percentUsed: Number.NaN, resetsAt: '2026-11-02T04:00:00Z' }] })
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  const { line } = await bandLine($)
  expect(line).not.toContain('Weekly')
  expect(line).not.toContain('NaN')
})

test('no session cost yet means no Session part', async ($, on) => {
  engine(on, { cost: null })
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  expect((await bandLine($)).line).not.toContain('Session')
})

test('while a survey shows, the band steps aside', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  const ui = await $.ui.mount({ ...band(200, true), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Cache' })).toBeUndefined()
  await ui.unmount()
})

test('what the engine draws above the prompt stays beside the band', async ($, on) => {
  engine(on, { engineRow: true })
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  const ui = await $.ui.mount({ ...band(), surface: 'desktop' })
  const all = await texts(ui)
  // The engine stacks the rows (AbovePromptList); the band never takes another row's place.
  expect(all).toContain('engine row')
  expect(all).toContain('Cache')
  await ui.unmount()
})

test('a value an earlier version stored is declined', async ($, on) => {
  on('state.get', () => ({ value: { value: { lastAt: 'bad' }, version: 1 } }))
  mock.clock(on, { now: 0 })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const ui = await $.ui.mount({ ...band(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Waiting for the first reply/ })).toBeDefined()
  await ui.unmount()
})

// ── The pane ────────────────────────────────────────────────────────────────

test('the pane breaks everything down on every surface and at any width', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await step($)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (const columns of [24, 40, 60, 120]) {
      const ui = await $.ui.mount({ ...pane(columns), surface })
      const all = await texts(ui)
      for (const want of ['Prompt Cache', 'Next Message', 'Keep Warm', 'This Session', 'Usage Limits', 'Opus 5.5', 'Extra High', '96%', '2']) {
        expect([surface, columns, want, all.includes(want)]).toEqual([surface, columns, want, true])
      }
      expect(all.some(t => t.includes('n/a') || t.includes('NaN') || t.includes('undefined'))).toBe(false)
      await ui.unmount()
    }
  }
})

test('the pane shows the effort as the request asked for it', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($, { effort: 32_000 })
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '32k budget' })).toBeDefined()
  await ui.unmount()
})

test('/cache opens the pane, or prints the figures where no pane can be seated', async ($, on) => {
  engine(on, { placed: false, limits: [WEEKLY] })
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  const text = await cache($)
  expect(text).toContain('Prompt Cache  Warm, 1h 00m left (TTL 1h)')
  expect(text).toContain('Model         Opus 5.5, effort Extra High')
  expect(text).toContain('Next Message  $0.06 warm, $2.41 cold')
  expect(text).toContain('Weekly        88% used, resets in 2d 4h')
  expect(text).not.toContain('n/a')
})

test('/cache with a pane says where it went', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  expect(await cache($)).toBe('Prompt Cache details are open in the side pane.')
})

// ── The cold send guard ─────────────────────────────────────────────────────

test('the first message into a cold cache is held once with its price; the resend goes', { options: { guard: 'confirm' } }, async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(HOUR + 5 * MIN)
  const first = await send($, 'what next?')
  expect(first.drop).toBe(
    'Cache Meter: The prompt cache went cold 5m ago. This message re-writes ~301k tokens on Opus 5.5 for $2.41 (a warm read would be $0.06). Send it again to go ahead, or /clear and start from a short summary. /cache guard off stops these holds.',
  )
  expect((await send($, 'what next?')).drop).toBeUndefined()
})

test('the guard lets through warm sends, small contexts, commands and prompts nobody typed', { options: { guard: 'confirm' } }, async ($, on) => {
  const { state } = engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  expect((await send($, 'warm still')).drop).toBeUndefined()
  await clock.advance(2 * HOUR)
  expect((await send($, '/clear')).drop).toBeUndefined()
  expect((await send($, 'a scheduled prompt', 'task-notification')).drop).toBeUndefined()
  expect((await send($, 'from the phone', 'bridge')).drop).toContain('went cold')

  state.usage = { ...OPUS, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 0 }
  await step($)
  await clock.advance(2 * HOUR)
  expect((await send($, 'small context')).drop).toBeUndefined()
})

test('guard warn only logs the price and lets the message through', { options: { guard: 'warn' } }, async ($, on) => {
  const { seen } = engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(2 * HOUR)
  expect((await send($, 'hi')).drop).toBeUndefined()
  expect(seen.logs.join('\n')).toContain('went cold 1h 00m ago')
})

test('guard off never holds', { options: { guard: 'off' } }, async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(2 * HOUR)
  expect((await send($, 'hi')).drop).toBeUndefined()
})

test('the guard switches off and on from the pane and with /cache guard, for this session', { options: { guard: 'confirm' } }, async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(2 * HOUR)
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Cold Send Guard' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Holds the message once/ })).toBeDefined()
  await ui.press({ key: 'guard-toggle' })
  await ui.unmount()
  expect((await send($, 'straight through')).drop).toBeUndefined()
  const after = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: /Every message goes straight through/ })).toBeDefined()
  await after.unmount()

  expect(await cache($, 'guard on')).toBe('The cold send guard is on for this session.')
  expect((await send($, 'held again')).drop).toContain('went cold')
  expect(await cache($, 'guard off')).toBe('The cold send guard is off for this session.')
  expect((await send($, 'and through')).drop).toBeUndefined()
  expect(await cache($, 'guard')).toBe('The cold send guard is on for this session.')
  expect(await cache($, 'GUARD   Off')).toBe('The cold send guard is off for this session.')
})

test('switched on over an off setting the guard holds; over warn it keeps warning', { options: { guard: 'off' } }, async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(2 * HOUR)
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Every message goes straight through/ })).toBeDefined()
  await ui.unmount()
  expect(await cache($, 'guard')).toBe('The cold send guard is on for this session.')
  expect((await send($, 'hi')).drop).toContain('went cold')
})

test('a warn setting switched off and on again still only warns', { options: { guard: 'warn' } }, async ($, on) => {
  const { seen } = engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(2 * HOUR)
  await cache($, 'guard off')
  expect((await send($, 'quiet')).drop).toBeUndefined()
  expect(seen.logs.length).toBe(0)
  await cache($, 'guard on')
  expect((await send($, 'loud')).drop).toBeUndefined()
  expect(seen.logs.join('\n')).toContain('went cold')
})

test('/cache prints the guard where no pane can be seated', async ($, on) => {
  engine(on, { placed: false })
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  expect(await cache($)).toContain('Cold Guard    Off (Plugin settings, every repo). /cache guard switches it.')
  await cache($, 'guard on')
  expect(await cache($)).toContain('Cold Guard    On, holds the message once (This session). /cache guard switches it.')
})

test('out of the box the guard and Keep Warm are both off: a cold send goes straight through and nothing pings', async ($, on) => {
  const { seen } = engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Every message goes straight through/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: 'Plugin settings, every repo' })).length).toBe(2)
  await ui.unmount()
  await clock.advance(2 * HOUR)
  expect(seen.forks).toBe(0)
  expect((await send($, 'cold but free to go')).drop).toBeUndefined()
})

test('an unknown guard value falls back to off, never to holding messages', { options: { guard: 'sometimes' } }, async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(2 * HOUR)
  expect((await send($, 'hi')).drop).toBeUndefined()
})

test('a restart before the first reply keeps the known limits and the 1h TTL, so the guard prices it right', { options: { guard: 'confirm' } }, async ($, on) => {
  const { state } = engine(on, { limits: [WEEKLY] })
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  // The app restarts: the API has no limits to report until the next reply.
  state.limits = []
  await clock.advance(2 * HOUR)
  await start($)
  const { line } = await bandLine($)
  expect(line).toContain('Weekly 88% 2d 2h')
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'TTL 1h' })).toBeDefined()
  await ui.unmount()
  expect((await send($, 'back after days')).drop).toContain('for $2.41')
})

// ── Per repo ────────────────────────────────────────────────────────────────

for (const [root, held] of [['/work/app', true], ['/work/app/.claude/worktrees/fix-x', true], ['/work/other', false]] as const) {
  test(`a repo that keeps the guard on holds in its sessions and worktrees, no other repo: ${root}`, async ($, on) => {
    engine(on, { root, store: { 'repo:/work/app': { guard: true } } })
    const clock = mock.clock(on, { now: NOW })
    await start($)
    await step($)
    await clock.advance(2 * HOUR)
    expect((await send($, 'hi')).drop !== undefined).toBe(held)
  })
}

test('/cache guard repo on keeps it for the repo and takes over this session; reset hands it back to the settings', async ($, on) => {
  const { store } = engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(2 * HOUR)
  expect(await cache($, 'guard repo')).toBe('The cold send guard is off here. This repo follows the plugin settings. /cache guard repo on, off or reset changes that.')
  await cache($, 'guard on')
  expect(await cache($, 'guard repo off')).toBe('The cold send guard is off in every session in /work/app.')
  expect((await send($, 'repo says off')).drop).toBeUndefined()
  expect(store.get('repo:/work/app')).toEqual({ guard: false })
  expect(await cache($, 'guard repo on')).toBe('The cold send guard is on in every session in /work/app.')
  expect((await send($, 'repo says on')).drop).toContain('went cold')
  expect(await cache($, 'guard repo reset')).toBe('/work/app follows the plugin settings again: The cold send guard is off.')
  expect(store.get('repo:/work/app')).toBeUndefined()
  expect((await send($, 'settings say off')).drop).toBeUndefined()
})

test('this session wins over the repo, and the repo over the settings', { options: { guard: 'confirm' } }, async ($, on) => {
  engine(on, { store: { 'repo:/work/app': { guard: false } } })
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(2 * HOUR)
  expect((await send($, 'repo off beats settings on')).drop).toBeUndefined()
  await cache($, 'guard on')
  expect((await send($, 'session on beats repo off')).drop).toContain('went cold')
})

test('Keep Warm kept on for the repo pings in a new session there', async ($, on) => {
  const { seen } = engine(on, { store: { 'repo:/work/app': { warm: true } } })
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(56 * MIN)
  expect(seen.forks).toBe(1)
  expect(await cache($, 'warm repo reset')).toBe('/work/app follows the plugin settings again: Keep Warm is off.')
  await clock.advance(HOUR)
  expect(seen.forks).toBe(1)
})

test('the pane shows where each switch is set and keeps the current state for the repo with one press', async ($, on) => {
  const { store } = engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(), surface })
    expect(await ui.find({ type: 'Text', text: 'Follows settings' })).toBeDefined()
    await ui.unmount()
  }
  await cache($, 'warm on')
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'This session' })).toBeDefined()
  await ui.press({ key: 'warm-repo' })
  await ui.unmount()
  expect(store.get('repo:/work/app')).toEqual({ warm: true })
  const after = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: 'Always on' })).toBeDefined()
  expect(await after.find({ type: 'Text', text: 'This repo' })).toBeDefined()
  await after.press({ key: 'warm-repo' })
  await after.unmount()
  expect(store.get('repo:/work/app')).toBeUndefined()
})

// ── Keep Warm ───────────────────────────────────────────────────────────────

test('Keep Warm is off by default and never pings', async ($, on) => {
  const { seen } = engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(3 * HOUR)
  expect(seen.forks).toBe(0)
})

test('Keep Warm switches from the pane and with /cache warm', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Off' })).toBeDefined()
  await ui.press({ key: 'keep-warm-toggle' })
  await ui.unmount()
  const after = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: 'On' })).toBeDefined()
  await after.unmount()
  expect(await cache($, 'warm off')).toBe('Keep Warm is off for this session.')
  expect(await cache($, 'warm on')).toBe('Keep Warm is on for this session.')
  expect(await cache($, 'warm')).toBe('Keep Warm is off for this session.')
})

test('Keep Warm pings five minutes before the end, keeps it warm, and stops after its window', { options: { keepWarm: 'on', keepWarmFor: '2h' } }, async ($, on) => {
  const { seen } = engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(54 * MIN)
  expect(seen.forks).toBe(0)
  await clock.advance(2 * MIN)
  expect(seen.forks).toBe(1)
  let { line } = await bandLine($)
  expect(line).toContain('Warm')
  expect(line).toContain('Kept Warm')
  await clock.advance(HOUR)
  expect(seen.forks).toBe(2)
  // Past two hours after the last message it lets go.
  await clock.advance(3 * HOUR)
  expect(seen.forks).toBe(2)
  ;({ line } = await bandLine($))
  expect(line).toContain('Cold')
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '2' })).toBeDefined()
  await ui.unmount()
})

test('a ping that finds the cache gone switches Keep Warm off and says so', { options: { keepWarm: 'on' } }, async ($, on) => {
  const { seen } = engine(on, { fork: FORK_MISS })
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(56 * MIN)
  expect(seen.forks).toBe(1)
  expect(seen.toasts.join('\n')).toContain('switched itself off')
  await clock.advance(2 * HOUR)
  expect(seen.forks).toBe(1)
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /1 too late/ })).toBeDefined()
  await ui.unmount()
})

test('a fork with nothing to fork or an API error changes nothing', { options: { keepWarm: 'on' } }, async ($, on) => {
  const { seen, state } = engine(on, { fork: { isAnswered: false, reason: 'nothing-to-fork' } })
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await clock.advance(56 * MIN)
  expect(seen.forks).toBeGreaterThan(0)
  state.fork = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  await clock.advance(MIN)
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'On' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /too late/ })).toBeUndefined()
  await ui.unmount()
  // Never counted as a ping, so the cache still runs out on time.
  await clock.advance(5 * MIN)
  expect((await bandLine($)).line).toContain('Cold')
})

test('Keep Warm never pings a cache the model switch already lost', { options: { keepWarm: 'on' } }, async ($, on) => {
  const { seen } = engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await switchModel($, 'claude-sonnet-5-5')
  await clock.advance(56 * MIN)
  expect(seen.forks).toBe(0)
})
