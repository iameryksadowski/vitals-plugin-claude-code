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
  ({ plugin: 'vitals', component: 'AbovePrompt', props: bandProps(bodyColumns, hasSurvey) }) as const
const pane = (bodyColumns = 60) =>
  ({
    plugin: 'vitals',
    component: 'Pane',
    requestId: 'vitals',
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
  /** The /context breakdown the engine hands back when asked for one. */
  breakdown?: Breakdown
  /** What `session.compact` answers: the compacted conversation, or a skip. */
  compact?: Compaction
  /** What `config.set` answers. */
  config?: { deny: string }
}

/** What `session.compact` answers: the conversation after it (its summary), or a skip. */
type Compaction = { messages: Array<{ role: 'user'; text: string; toolUses: never[] }> } | { skip: string }
const SUMMARY: Compaction = { messages: [{ role: 'user', text: 'Summary of the conversation so far.', toolUses: [] }] }

type Breakdown = {
  categories: Array<{ name: string; tokens: number; color: string; isDeferred: boolean; kind: 'used' | 'free' | 'buffer' | 'deferred' }>
  maxTokens: number
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
  mcpTools: Array<{ name: string; serverName: string; tokens: number; isLoaded: boolean }>
}

const cat = (name: string, tokens: number, kind: 'used' | 'free' = 'used') => ({ name, tokens, color: 'text', isDeferred: false, kind })
const tool = (serverName: string, name: string, tokens: number) => ({ name: `mcp__${serverName}__${name}`, serverName, tokens, isLoaded: true })
/** A 1M window with auto-compact on at 330k: a 301k context is within ten points of it. */
const BREAKDOWN: Breakdown = {
  categories: [cat('System prompt', 20_000), cat('Messages', 250_000), cat('MCP tools', 31_000), cat('Free space', 699_000, 'free')],
  maxTokens: 1_000_000,
  autoCompactThreshold: 330_000,
  isAutoCompactEnabled: true,
  mcpTools: [tool('linear', 'create_issue', 12_000), tool('figma', 'get_design', 9_000), tool('linear', 'list_issues', 10_000)],
}

/** The engine beneath the plugin, with counters a test reads back. */
const engine = (on: On, w: World = {}) => {
  const seen = { forks: 0, logs: [] as string[], toasts: [] as string[], compacts: 0, config: [] as Array<{ key: string; value: unknown }> }
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
  // The default config folder: account A, on a machine with a second account next to it.
  mock.env(on, { HOME: '/Users/test' })
  on('fs.list', (_, e) => ({
    value: (e as { path?: string }).path === '/Users/test'
      ? ['.claude', '.claude-b'].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }))
      : [],
  }))
  const state = {
    usage: w.usage ?? OPUS,
    limits: w.limits ?? [FIVE_HOUR, WEEKLY],
    fork: w.fork ?? FORK_HIT,
    root: w.root ?? '/work/app',
    breakdown: w.breakdown ?? null,
    compact: w.compact ?? SUMMARY,
  }
  on('session.usage', (_, e) => ({
    value: {
      startedAt: 0,
      context: {
        tokens: 300_000,
        window: 1_000_000,
        percent: 30,
        ...((e as { breakdown?: string } | undefined)?.breakdown && state.breakdown ? { breakdown: state.breakdown as never } : {}),
      },
      rateLimits: state.limits,
      cost: w.cost === null ? undefined : { usd: w.cost ?? 3.5 },
    },
  }))
  on('session.model', () => ({ value: state.usage.model }))
  on('session.root', () => ({ value: state.root }))
  on('session.cwd', () => ({ value: state.root }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.compact', () => {
    seen.compacts += 1
    return state.compact as never
  })
  on('config.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    seen.config.push({ key, value })
    return w.config ?? { value: value as never }
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('command.register', () => ({ value: { command: 'vitals' } }))
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
const cache = async ($: $T, args = '') => ((await $.command.run({ command: 'vitals', args } as never)) as { text?: string }).text ?? ''

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

type Tab = 'now' | 'context' | 'cost' | 'timeline' | 'settings'
/** The pane mounted and switched to one tab, as a person pressing the tab button does. */
const paneAt = async ($: $T, tab: Tab, columns = 60, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' = 'desktop') => {
  const ui = await $.ui.mount({ ...pane(columns), surface })
  await ui.press({ key: `tab-${tab}` })
  return ui
}

/** Lets the plugin's fire-and-forget work (a store write, a context read) run: a few round trips through the engine. */
const settle = async ($: $T) => {
  for (let i = 0; i < 10; i++) await $.command.run({ command: 'vitals', args: 'fields' } as never)
}

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
    // The limits and the live context are known before any reply; the cache figures are not.
    for (const none of ['Next', 'Cold', 'Warm', 'Compact']) expect(line).not.toContain(none)
    expect(line).toContain('Weekly 88% 2d 4h')
    expect(line).toContain('Context 300k 30%')
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
  expect(line).toBe(['● Cache Warm 1h 00m left', 'Next $0.06', 'A', '5-Hour 42% 3h 10m', 'Weekly 88% 2d 4h', 'Context 301k 30%'].join(SEP))
})

test('the band shows the other fields on request, in the order asked', { options: { bandFields: 'cache, next, ifcold, context, hit, 5h, 7d, spend, session' } }, async ($, on) => {
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

test('an API key with no limits caches for 5 minutes and shows no limit', { options: { bandFields: 'cache, next, ifcold, 5h, 7d, spend, context' } }, async ($, on) => {
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

test('after compaction the cache is cold, compacted, priced from the live context, and the session figures stay', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await $.classic.SessionStart({ source: 'compact' } as never)
  const { line } = await bandLine($)
  expectTidy(line)
  // The live context is 300k: written on Opus 5.5 at the 1h rate, $8/MTok.
  expect(line).toBe(['● Cache Cold After compaction', 'Next $2.40 Re-cache', 'A', '5-Hour 42% 3h 10m', 'Weekly 88% 2d 4h', 'Context 300k 30%'].join(SEP))
  expect(line).not.toContain('Idle')
  expect(line).not.toContain('Waiting')
  // A just-compacted cache is no reason to compact again.
  expect(line).not.toContain('Compact cache cold')
  const now = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await now.find({ type: 'Text', text: /The conversation was compacted, the next message caches its summary/ })).toBeDefined()
  await now.unmount()
  const cost = await paneAt($, 'cost')
  expect(await cost.find({ type: 'Text', text: '96%' })).toBeDefined()
  expect(await cost.find({ type: 'Text', text: 'None yet' })).toBeUndefined()
  await cost.unmount()
  // The first reply after it writes the cache: warm again.
  await step($)
  expect((await bandLine($)).line).toContain('● Cache Warm 1h 00m left')
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
  const WANT: Record<Tab, string[]> = {
    now: ['Account', 'Prompt Cache', 'Next Message', 'Usage Limits', 'Opus 5.5', 'Extra High'],
    context: ['Context', 'Auto-Compact', 'Advice'],
    cost: ['This Session', '96%', '2'],
    timeline: ['Timeline'],
    settings: ['Status Line', 'Keep Warm', 'Cold Send Guard', 'Compact Hint'],
  }
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (const columns of [24, 40, 60, 120]) {
      for (const tab of ['now', 'context', 'cost', 'timeline', 'settings'] as const) {
        const ui = await paneAt($, tab, columns, surface)
        const all = await texts(ui)
        for (const want of WANT[tab]) expect([surface, columns, tab, want, all.includes(want)]).toEqual([surface, columns, tab, want, true])
        // Each tab holds its own cards only.
        for (const other of ['Keep Warm', 'This Session', 'Next Message']) {
          if (!WANT[tab].includes(other)) expect([surface, columns, tab, other, all.includes(other)]).toEqual([surface, columns, tab, other, false])
        }
        expect(all.some(t => t.includes('n/a') || t.includes('NaN') || t.includes('undefined'))).toBe(false)
        await ui.unmount()
      }
    }
  }
})

test('the pane opens on Now; /cache settings, cost, context and timeline open it on that tab', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  const first = await $.ui.mount({ ...pane(), surface: 'desktop' })
  expect(await first.find({ type: 'Text', text: 'Prompt Cache' })).toBeDefined()
  expect(await first.find({ type: 'Text', text: 'Keep Warm' })).toBeUndefined()
  expect((await first.find({ key: 'tab-now' }))?.props.variant).toBe('primary')
  await first.unmount()
  for (const [tab, label, card] of [['settings', 'Settings', 'Keep Warm'], ['cost', 'Cost', 'This Session'], ['context', 'Context', 'Auto-Compact'], ['timeline', 'Timeline', 'Timeline']] as const) {
    expect(await cache($, tab)).toBe(`${label} is open in the side pane.`)
    const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
    expect([tab, (await ui.find({ key: `tab-${tab}` }))?.props.variant]).toEqual([tab, 'primary'])
    expect([tab, (await ui.find({ type: 'Text', text: card })) !== undefined]).toEqual([tab, true])
    expect([tab, (await ui.find({ type: 'Text', text: 'Next Message' })) === undefined]).toEqual([tab, true])
    await ui.unmount()
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
  expect(await cache($)).toBe('Vitals is open in the side pane.')
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
    'Vitals: The prompt cache went cold 5m ago. This message re-writes ~301k tokens on Opus 5.5 for $2.41 (a warm read would be $0.06). Send it again to go ahead, or /clear and start from a short summary. /vitals guard off stops these holds.',
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
  const ui = await paneAt($, 'settings')
  expect(await ui.find({ type: 'Text', text: 'Cold Send Guard' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Holds the message once/ })).toBeDefined()
  await ui.press({ key: 'guard-toggle' })
  await ui.unmount()
  expect((await send($, 'straight through')).drop).toBeUndefined()
  const after = await paneAt($, 'settings')
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
  const ui = await paneAt($, 'settings')
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
  expect(await cache($)).toContain('Cold Guard    Off (Plugin settings, every repo). /vitals guard switches it.')
  await cache($, 'guard on')
  expect(await cache($)).toContain('Cold Guard    On, holds the message once (This session). /vitals guard switches it.')
})

test('out of the box the guard and Keep Warm are both off: a cold send goes straight through and nothing pings', async ($, on) => {
  const { seen } = engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  const ui = await paneAt($, 'settings')
  expect(await ui.find({ type: 'Text', text: /Every message goes straight through/ })).toBeDefined()
  expect((await ui.find({ key: 'keep-warm-toggle' }))?.text).toBe('Turn On')
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
  expect(await cache($, 'guard repo')).toBe('The cold send guard is off here. This repo follows the plugin settings. /vitals guard repo on, off or reset changes that.')
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
    const ui = await paneAt($, 'settings', 60, surface)
    expect(await ui.find({ type: 'Text', text: 'Follows settings' })).toBeDefined()
    await ui.unmount()
  }
  await cache($, 'warm on')
  const ui = await paneAt($, 'settings')
  expect(await ui.find({ type: 'Text', text: 'This session' })).toBeDefined()
  await ui.press({ key: 'warm-repo' })
  await ui.unmount()
  expect(store.get('repo:/work/app')).toEqual({ warm: true })
  const after = await paneAt($, 'settings')
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
  const ui = await paneAt($, 'settings')
  expect((await ui.find({ key: 'keep-warm-toggle' }))?.text).toBe('Turn On')
  await ui.press({ key: 'keep-warm-toggle' })
  await ui.unmount()
  const after = await paneAt($, 'settings')
  expect((await after.find({ key: 'keep-warm-toggle' }))?.text).toBe('Turn Off')
  expect(await after.find({ type: 'Text', text: 'This session' })).toBeDefined()
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
  // The Pings row on the Settings tab counts both.
  const ui = await paneAt($, 'settings')
  expect(await ui.find({ type: 'Text', text: '2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$0\.\d\d in all/ })).toBeDefined()
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
  const ui = await paneAt($, 'settings')
  expect(await ui.find({ type: 'Text', text: /1 too late/ })).toBeDefined()
  expect((await ui.find({ key: 'keep-warm-toggle' }))?.text).toBe('Turn On')
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
  const ui = await paneAt($, 'settings')
  expect((await ui.find({ key: 'keep-warm-toggle' }))?.text).toBe('Turn Off')
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

// ── A session that comes back ───────────────────────────────────────────────

test('the last request of each session is kept by session id, and a new start with no facts seeds from it', async ($, on) => {
  const other = { lastAt: NOW - 3 * HOUR, ctx: 50_000, window: 200_000, model: 'claude-sonnet-5-5', effort: 'low' }
  const { store } = engine(on, {
    store: { sessions: { 'sess-1': { lastAt: NOW - 20 * MIN, ctx: 301_000, window: 1_000_000, model: 'claude-opus-5-5', effort: 'xhigh' }, 'sess-0': other } },
  })
  const clock = mock.clock(on, { now: NOW })
  await start($)
  // The real idle time, not a wait for the first reply.
  const { line } = await bandLine($)
  expect(line.startsWith(['● Cache Warm 40m left', 'Next $0.06'].join(SEP))).toBe(true)
  expect(line).not.toContain('Waiting')
  await clock.advance(MIN)
  await step($)
  await settle($)
  const kept = store.get('sessions') as Record<string, unknown>
  expect(kept['sess-1']).toEqual({ lastAt: NOW + MIN, ctx: 301_000, window: 1_000_000, model: 'claude-opus-5-5', effort: 'xhigh' })
  // Other sessions' entries stay.
  expect(kept['sess-0']).toEqual(other)
})

test('a session that comes back after the TTL reads cold with its idle time', async ($, on) => {
  engine(on, { store: { sessions: { 'sess-1': { lastAt: NOW - 2 * HOUR, ctx: 301_000, window: 1_000_000, model: 'claude-opus-5-5', effort: 'xhigh' } } } })
  mock.clock(on, { now: NOW })
  await start($)
  expect((await bandLine($)).line).toContain('● Cache Cold Idle 2h 00m  │  Next $2.41 Re-cache')
})

test('a session with nothing kept for its id waits for the first reply', async ($, on) => {
  engine(on, { store: { sessions: { 'sess-0': { lastAt: NOW - 20 * MIN, ctx: 301_000, window: 1_000_000, model: 'claude-opus-5-5', effort: 'xhigh' } } } })
  mock.clock(on, { now: NOW })
  await start($)
  expect((await bandLine($)).line).toContain('○ Prompt Cache Waiting for the first reply')
})

// ── Compacting ──────────────────────────────────────────────────────────────

test('a compaction of the main conversation makes the band read Cold, Compacted; a subagent compaction changes nothing', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  const messages = (SUMMARY as { messages: unknown[] }).messages
  await $.session.compact({ trigger: 'auto', agentId: 'a1', messages } as never)
  expect((await bandLine($)).line).toContain('● Cache Warm 1h 00m left')
  await $.session.compact({ trigger: 'manual', messages } as never)
  await settle($)
  const { line } = await bandLine($)
  expect(line.startsWith(['● Cache Cold After compaction', 'Next $2.40 Re-cache'].join(SEP))).toBe(true)
})

// `/cache compact` cannot compact inside its own command.run hook (the host refuses it under
// the turn the hook holds), so it queues the compaction: a timer right after, or the turn's end.
test('/cache compact queues the compaction and the end of the turn runs it', async ($, on) => {
  const { seen } = engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  expect(await cache($, 'compact')).toBe('Compacting as soon as this command is done.')
  await $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(seen.compacts).toBe(1)
  // Its own compaction resets the cache to cold, compacted: the engine skips this plugin's own hook for it.
  expect((await bandLine($)).line).toContain('● Cache Cold After compaction')
})

test('Compact Now asks the engine to compact; a skip leaves the cache warm', async ($, on) => {
  const { seen, state } = engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  state.compact = { skip: 'Not enough messages to compact' }
  const ui = await paneAt($, 'context')
  await ui.press({ key: 'compact-now' })
  await ui.unmount()
  expect(seen.compacts).toBe(1)
  expect((await bandLine($)).line).toContain('● Cache Warm 1h 00m left')
})

test('/cache autocompact switches Claude Code auto-compact through config.set', async ($, on) => {
  const { seen } = engine(on, { breakdown: BREAKDOWN })
  mock.clock(on, { now: NOW })
  await start($)
  await settle($)
  expect(await cache($, 'autocompact off')).toBe('Auto-compact is off.')
  expect(seen.config).toEqual([{ key: 'autoCompact', value: false }])
  expect(await cache($, 'autocompact on')).toBe('Auto-compact is on.')
  // Left out, it flips what the engine reports: on here, so off.
  expect(await cache($, 'autocompact')).toBe('Auto-compact is off.')
  expect(seen.config.map(c => c.value)).toEqual([false, true, false])
})

test('a refused auto-compact switch says why and changes nothing', async ($, on) => {
  const { seen } = engine(on, { breakdown: BREAKDOWN, config: { deny: 'Set by your organization' } })
  mock.clock(on, { now: NOW })
  await start($)
  expect(await cache($, 'autocompact off')).toBe('Auto-compact stays on: Set by your organization')
  expect(seen.config).toEqual([{ key: 'autoCompact', value: false }])
})

test('near auto-compact the band hints at compacting, and the Context tab breaks the context down', async ($, on) => {
  const { seen } = engine(on, { breakdown: BREAKDOWN })
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await settle($)
  const { line } = await bandLine($)
  expectTidy(line)
  expect(line.endsWith(['Context 301k 30%', 'Compact auto-compact at 33%'].join(SEP))).toBe(true)
  const ui = await paneAt($, 'context')
  const all = await texts(ui)
  expect(all).toContain('Compact now: auto-compact at 33%.')
  expect(all).toContain('  ·  Runs at 33%, 3 points to go')
  expect(all).toContain('What Fills It')
  // The largest category first; the free space is no part of what fills it.
  expect(all.indexOf('Messages')).toBeLessThan(all.indexOf('MCP tools'))
  expect(all).toContain('250k')
  expect(all).not.toContain('Free space')
  // MCP servers summed over their tools, heaviest first.
  expect(all).toContain('Heaviest MCP Servers')
  expect(all.indexOf('linear')).toBeLessThan(all.indexOf('figma'))
  expect(all).toContain('22k')
  await ui.press({ key: 'auto-toggle' })
  expect(seen.config).toEqual([{ key: 'autoCompact', value: false }])
  await ui.press({ key: 'compact-now' })
  expect(seen.compacts).toBe(1)
  await ui.unmount()
})

test('no hint while there is no reason; without a breakdown a cold cache over compactAt gets one', { options: { compactAt: '30' } }, async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await settle($)
  expect((await bandLine($)).line).not.toContain('Compact')
  await clock.advance(2 * HOUR)
  expect((await bandLine($)).line).toContain('Compact cache cold, context 30%')
})

test('compactHint off shows no hint, even near auto-compact', { options: { compactHint: 'off' } }, async ($, on) => {
  engine(on, { breakdown: BREAKDOWN })
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await settle($)
  expect((await bandLine($)).line).not.toContain('Compact')
  const ui = await paneAt($, 'context')
  expect(await ui.find({ type: 'Text', text: 'The compact hint is off in the settings.' })).toBeDefined()
  await ui.unmount()
})

// ── The timeline ────────────────────────────────────────────────────────────

const prompt = ($: $T, text: string, source?: 'user' | 'system' | 'schedule_wakeup') =>
  $.classic.UserPromptSubmit({
    hook_event_name: 'UserPromptSubmit', session_id: 's', transcript_path: '/t', cwd: '/work/app', prompt: text, permission_mode: 'default', ...(source ? { source } : {}),
  } as never)

test('the timeline records your message and the reply with its time and tools, and the Timeline tab shows them', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: NOW })
  await start($)
  const empty = await paneAt($, 'timeline')
  expect(await empty.find({ type: 'Text', text: /^Nothing yet/ })).toBeDefined()
  await empty.unmount()
  await prompt($, 'Fix the login\n   bug please')
  await $.tool.call({ name: 'Read', input: { file_path: '/work/app/a.ts' } } as never)
  await $.tool.call({ name: 'Grep', input: { pattern: 'login' } } as never)
  await step($)
  await clock.advance(42_000)
  await $.turn.complete({ answer: 'done', durationMs: 42_000, isAborted: false, turnId: 't1', reason: 'answer' })
  // A prompt nobody typed is no message of yours: it shows under who sent it.
  await prompt($, 'scheduled check', 'schedule_wakeup')
  await prompt($, '<system-reminder>Session moved.</system-reminder>', 'system')
  await prompt($, '<cross-session-message from="uds:/tmp/x.sock">Final names for the plugin</cross-session-message>', 'system')
  await clock.advance(2 * HOUR)
  await prompt($, 'back again')
  expect(await cache($, 'timeline')).toBe('Timeline is open in the side pane.')
  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })
  const all = await texts(ui)
  expect(all).toContain('2 messages from you')
  expect(all).toContain('Fix the login bug please')
  expect(all).toContain('back again')
  expect(all).toContain('Claude')
  expect(all).toContain('  ·  took 42s  ·  2 tools')
  expect(all).toContain('2h 00m idle before it, the cache had gone cold')
  // The newest first, and the gap under the message that paid for it.
  const order = ['back again', '2h 00m idle before it, the cache had gone cold', 'Final names for the plugin', 'scheduled check', 'done', 'Fix the login bug please'].map(t => all.indexOf(t))
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(order.includes(-1)).toBe(false)
  expect(all).toContain('Scheduled')
  expect(all).toContain('scheduled check')
  expect(all).toContain('App')
  expect(all).toContain('Session')
  expect(all).toContain('Final names for the plugin')
  expect(all.some(t => t.includes('system-reminder') || t.includes('cross-session'))).toBe(false)
  await ui.unmount()
})

test('a narrowing band lets the next price go before the context, cold or warm', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await $.classic.SessionStart({ source: 'compact' } as never)
  // Too narrow for two of its parts: the second limit goes, then the price, and the context stays.
  const full = (await bandLine($, 200)).line
  const { line } = await bandLine($, full.length + 2 + 9 - 30)
  expectTidy(line)
  expect(line).toContain('Cache Cold After compaction')
  expect(line).toContain('Context 300k 30%')
  expect(line).not.toContain('Next')
})

test('a long message wraps in the timeline instead of being cut at the pane edge', async ($, on) => {
  engine(on)
  mock.clock(on, { now: NOW })
  await start($)
  const long = 'This message is long enough to need more than one line in a narrow pane, and it keeps going for a while.'
  await prompt($, long)
  const ui = await paneAt($, 'timeline', 40)
  const row = await ui.find({ type: 'Text', text: long })
  expect(row).toBeDefined()
  expect((row as { props?: { wrap?: string } }).props?.wrap ?? 'wrap').toBe('wrap')
  await ui.unmount()
})
