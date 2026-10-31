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
  props: { title: 'Prompt Cache', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const HOUR = 60 * 60 * 1000
const FIVE_HOUR = { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-31T05:00:00Z' }
const SEVEN_DAY = { kind: 'seven_day', percentUsed: 88, resetsAt: '2026-11-03T00:00:00Z' }

/** The engine beneath the plugin: usage, model, commands, panes, and one 300k-token Opus 5.5 request. */
const engine = (on: On, rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[] = [FIVE_HOUR, SEVEN_DAY], forks = { n: 0 }) => {
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 300_000, window: 1_000_000, percent: 30 }, rateLimits, cost: { usd: 3.5 } },
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
  // A Keep Warm fork the cache serves: the whole prefix read, a one-word reply.
  on('model.fork', () => {
    forks.n += 1
    return {
      value: {
        isAnswered: true as const,
        text: 'OK',
        usage: { input_tokens: 30, output_tokens: 2, cache_read_input_tokens: 301_000, cache_creation_input_tokens: 0 },
      },
    }
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
  const run = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 10 })
  for await (const _ of run) void _
}

test('the band waits for the first reply, then shows a warm cache and the usage windows', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Waiting for the first reply/ }))?.text).toContain('Waiting')
    await ui.unmount()
  }

  await step($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'Warm' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1h 00m left' })).toBeDefined()
    // 301k tokens read at $0.20/MTok.
    expect(await ui.find({ type: 'Text', text: '$0.06' })).toBeDefined()
    // ...and written at the 1h rate, $8/MTok, once cold.
    expect(await ui.find({ type: 'Text', text: '$2.41' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '88%' })).toBeDefined()
    await ui.unmount()
  }
})

test('a plan held to the 7d window alone shows the weekly limit and no 5-hour one, and keeps the 1h TTL', async ($, on) => {
  // Ultra: the API reports seven_day only; an idle five_hour (nothing used, no reset) is left out too.
  engine(on, [{ kind: 'five_hour', percentUsed: 0 }, SEVEN_DAY])
  // Three days before the weekly reset, so its countdown reads as it would.
  mock.clock(on, { now: Date.parse('2026-10-31T00:00:00Z') })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: 'Weekly ' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '5-Hour ' })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: '1h 00m left' })).toBeDefined()
    await band.unmount()

    // On a narrow band the weekly limit outlasts everything but the cache state.
    const narrow = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, bodyColumns: 80 } })
    expect(await narrow.find({ type: 'Text', text: 'Weekly ' })).toBeDefined()
    expect(await narrow.find({ type: 'Text', text: '  3d 0h' })).toBeDefined()
    expect(await narrow.find({ type: 'Text', text: '1h 00m left' })).toBeDefined()
    await narrow.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: 'Weekly' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '5-Hour' })).toBeUndefined()
    await pane.unmount()
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
  expect(await ui.find({ type: 'Text', text: 'Cold' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Idle 1h 05m' })).toBeDefined()
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
    expect(await ui.find({ type: 'Text', text: 'Prompt Cache' })).toBeDefined()
    // 580k read of 600k input.
    expect(await ui.find({ type: 'Text', text: '97%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^  ·  \d+d \d+h$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Extra High' })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /Waiting for the first reply/ })).toBeDefined()
  await ui.unmount()
})

test('Keep Warm is off by default and switched on from the pane', async ($, on) => {
  const forks = { n: 0 }
  engine(on, [SEVEN_DAY], forks)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($)
  await clock.advance(HOUR + 60 * 1000)
  expect(forks.n).toBe(0)

  // A fresh reply, then the toggle in the pane.
  await step($)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: 'Off' })).toBeDefined()
  await pane.press({ key: 'keep-warm-toggle' })
  await pane.unmount()

  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await again.find({ type: 'Text', text: 'On' })).toBeDefined()
  await again.unmount()
})

test('Keep Warm pings once before the TTL ends and stops after its window', { options: { keepWarm: 'on', keepWarmFor: '1h' } }, async ($, on) => {
  const forks = { n: 0 }
  engine(on, [SEVEN_DAY], forks)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($)

  // Five minutes before the hour runs out, one fork reads the cache and starts the TTL over.
  await clock.advance(HOUR - 4 * 60 * 1000)
  expect(forks.n).toBe(1)
  await clock.advance(10 * 60 * 1000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: 'Warm' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '  Kept Warm' })).toBeDefined()
  await band.unmount()

  // Past the 1h window after the last message it lets the cache go.
  await clock.advance(2 * HOUR)
  expect(forks.n).toBe(1)
  const cold = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await cold.find({ type: 'Text', text: 'Cold' })).toBeDefined()
  await cold.unmount()
})
