import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'cache-meter',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 160, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

const PANE = {
  plugin: 'cache-meter',
  component: 'Pane',
  requestId: 'cache-meter',
  props: { title: 'Prompt cache', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const HOUR = 60 * 60 * 1000
const FIVE_HOUR = { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-31T05:00:00Z' }
const SEVEN_DAY = { kind: 'seven_day', percentUsed: 88, resetsAt: '2026-11-03T00:00:00Z' }

/** The engine beneath the plugin: usage, model, commands, panes, and one 300k-token Opus 5.5 request. */
const engine = (on: On) => {
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 300_000, window: 1_000_000, percent: 30 }, rateLimits: [FIVE_HOUR, SEVEN_DAY], cost: { usd: 3.5 } },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('command.register', () => ({ value: { command: 'cache' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // The engine draws nothing of its own above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 2_000, output_tokens: 1_000, cache_read_input_tokens: 290_000, cache_creation_input_tokens: 8_000 },
    }
  })
}

const step = async ($: Parameters<TestBody>[0]) => {
  const run = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 10 })
  for await (const _ of run) void _
}

test('the band waits for the first reply, then shows a warm cache and the usage windows', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /waiting for the first reply/ }))?.text).toContain('waiting')
    await ui.unmount()
  }

  await step($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'warm' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1h00m left' })).toBeDefined()
    // 301k tokens read at $0.20/MTok.
    expect(await ui.find({ type: 'Text', text: '$0.06' })).toBeDefined()
    // ...and written at the 1h rate, $8/MTok, once cold.
    expect(await ui.find({ type: 'Text', text: '$2.41' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '88%' })).toBeDefined()
    await ui.unmount()
  }
})

test('after the TTL the band turns cold and the first send is held once with its price', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($)
  await clock.advance(HOUR + 5 * 60 * 1000)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'cold' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1h05m idle' })).toBeDefined()
  await ui.unmount()

  const first = await $.prompt.submit({ text: 'what next?', origin: { kind: 'composer' }, wait: false })
  expect(first.drop).toContain('went cold 5m ago')
  expect(first.drop).toContain('$2.41')
  const again = await $.prompt.submit({ text: 'what next?', origin: { kind: 'composer' }, wait: false })
  expect(again.drop).toBeUndefined()

  // A slash command is never held.
  await clock.advance(HOUR)
  const slash = await $.prompt.submit({ text: '/clear', origin: { kind: 'composer' }, wait: false })
  expect(slash.drop).toBeUndefined()
})

test('the guard can be switched off', { options: { guard: 'off' } }, async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($)
  await clock.advance(2 * HOUR)
  const r = await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false })
  expect(r.drop).toBeUndefined()
})

test('the pane breaks down the cache, the session and the windows on every surface', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($)
  await step($)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Prompt cache' })).toBeDefined()
    // 580k read of 600k input.
    expect(await ui.find({ type: 'Text', text: '97%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /resets in/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
    await ui.unmount()
  }
})

test('a value an earlier version stored is declined', async ($, on) => {
  on('state.get', () => ({ value: { value: { lastAt: 'bad' }, version: 1 } }))
  mock.clock(on, { now: 0 })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /waiting for the first reply/ })).toBeDefined()
  await ui.unmount()
})
