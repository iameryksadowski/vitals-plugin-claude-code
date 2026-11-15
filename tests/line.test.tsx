import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { alfredBody } from '../hooks/alfred'
import { meterApi, setLatest, shareOf } from '../hooks/share'
import { accountOf, clockOf, lineOf, loginFileOf, parseFields } from '../hooks/fields'
import type { LineData } from '../hooks/fields'
import { viewOf } from '../hooks/cache'

type $T = Parameters<TestBody>[0]
type LimitIn = { kind: string; percentUsed: number; resetsAt?: string }

const NOW = Date.parse('2026-11-14T12:00:00Z')
const HOME = '/Users/test'
/** Warsaw in November: one hour east of UTC. */
const TZ = '+0100'

const OPUS = { model: 'claude-opus-5-5', input_tokens: 2_000, output_tokens: 1_000, cache_read_input_tokens: 290_000, cache_creation_input_tokens: 8_000 }

type Account = {
  configDir?: string
  email?: string
  limits?: LimitIn[]
  surfaces?: Array<'terminal' | 'desktop'>
  statusLine?: string
  alfredUp?: boolean
  branch?: string
  context?: { tokens?: number; window: number; percent?: number }
  store?: Record<string, unknown>
}

/** One account's world beneath the plugin: its folder, login record, limits and the Alfred engine. */
const world = (on: On, a: Account = {}) => {
  const seen = { store: new Map<string, unknown>(), status: [] as Array<string | undefined>, writes: new Map<string, string>(), posts: [] as Array<{ url: string; headers: Record<string, string>; body: string }> }
  const store = new Map<string, unknown>(Object.entries(a.store ?? {}))
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
  mock.env(on, { HOME, TMPDIR: '/tmp/t/', ...(a.configDir ? { CLAUDE_CONFIG_DIR: a.configDir } : {}) })
  const login = a.configDir ? `${a.configDir}/.claude.json` : `${HOME}/.claude.json`
  const files: Record<string, string> = {
    [login]: JSON.stringify({ oauthAccount: { emailAddress: a.email ?? 'konto-a@example.com' } }),
    [`${HOME}/Development/alfred-app/data/api.token`]: 'local-token\n',
  }
  on('fs.read', (_, e) => {
    const path = (e as { path: string }).path
    if (!(path in files)) throw new Error(`ENOENT ${path}`)
    return { value: files[path]! }
  })
  on('fs.write', (_, e) => {
    const { path, text } = e as { path: string; text: string }
    seen.writes.set(path, text)
    return { value: undefined }
  })
  on('settings.read', () => ({ value: { effortLevel: 'medium', ...(a.statusLine ? { statusLine: { type: 'command', command: a.statusLine } } : {}) } }))
  on('process.run', (_, e) => {
    const argv = (e as { argv: readonly string[] }).argv
    if (argv[0] === 'date') return { value: { exitCode: 0, stdout: `${TZ}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'git') return { value: { exitCode: 0, stdout: `${a.branch ?? 'main'}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', (_, e) => {
    const { url, init } = e as { url: string; init?: { headers?: Record<string, string>; body?: string } }
    seen.posts.push({ url, headers: init?.headers ?? {}, body: init?.body ?? '' })
    if (a.alfredUp === false) return { deny: 'connect ECONNREFUSED 127.0.0.1:8765' }
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })
  on('ui.status', (_, e) => {
    seen.status.push((e as { text?: string }).text)
    return { value: undefined }
  })
  seen.store = store
  on('session.surfaces', () => ({ value: a.surfaces ?? ['desktop'] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.root', () => ({ value: '/work/app' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: a.context ?? { tokens: 300_000, window: 1_000_000, percent: 30 },
      rateLimits: a.limits ?? [],
      cost: { usd: 3.5 },
    },
  }))
  on('command.register', () => ({ value: { command: 'vitals' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: OPUS }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_, e) => ({ changed: [...e.changed] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('classic.UserPromptSubmit', () => ({}))
  on('prompt.compose', () => ({ sections: [] }))
  return seen
}

const LIMITS_B: LimitIn[] = [
  { kind: 'five_hour', percentUsed: 34, resetsAt: '2026-11-14T13:40:00Z' },
  { kind: 'seven_day', percentUsed: 55, resetsAt: '2026-11-16T02:00:00Z' },
]
const LIMITS_C: LimitIn[] = [{ kind: 'seven_day', percentUsed: 97, resetsAt: '2026-11-15T14:00:00Z' }]

const start = ($: $T, surface: 'terminal' | 'desktop' = 'desktop') => $.session.start({ cwd: '/work/app', surface, isInteractive: true })
const step = async ($: $T) => {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 4 })) void _
}
const cache = async ($: $T, args = '') => ((await $.command.run({ command: 'vitals', args } as never)) as { text?: string }).text ?? ''
const options = (o: Record<string, string>) => ({ options: o })
/** Lets the plugin's fire-and-forget work (a send to Alfred) run: a few round trips through the engine. */
const settle = async ($: $T) => {
  for (let i = 0; i < 10; i++) await $.command.run({ command: 'vitals', args: 'fields' } as never)
}

// --- fields, pure ---

test('the account is read from its config folder, a label wins', () => {
  expect(accountOf(undefined, HOME, '').label).toBe('A')
  expect(accountOf(`${HOME}/.claude`, HOME, '').label).toBe('A')
  expect(accountOf(`${HOME}/.claude-b`, HOME, '').label).toBe('B')
  expect(accountOf(`${HOME}/.claude-c/`, HOME, '').label).toBe('C')
  expect(accountOf(`${HOME}/.claude-work`, HOME, '').label).toBe('WORK')
  expect(accountOf(`${HOME}/.claude-b`, HOME, '.claude-b=Praca, A=1').label).toBe('Praca')
  expect(accountOf(undefined, HOME, '.claude-b=Praca, A=1').label).toBe('1')
  expect(accountOf(`${HOME}/.claude-c`, HOME, '~/.claude-c=3').label).toBe('3')
  expect(loginFileOf(undefined, HOME)).toEqual([`${HOME}/.claude.json`])
  expect(loginFileOf(`${HOME}/.claude-b`, HOME)).toEqual([`${HOME}/.claude-b/.claude.json`])
})

test('fields are read in order, once each, with aliases and the words that name none', () => {
  expect(parseFields('account, model 7d weekly ctx limits foo')).toEqual({ fields: ['account', 'model', '7d', 'context', '5h', 'spend'], unknown: ['foo'] })
  expect(parseFields('').fields).toEqual([])
})

test('a reset reads on the clock in the person zone: the time within a day, the day further off', () => {
  expect(clockOf('2026-11-14T13:40:00Z', NOW, 60)).toBe('14:40')
  expect(clockOf('2026-11-16T02:00:00Z', NOW, 60)).toBe('Mon 03:00')
  expect(clockOf('bad', NOW, 60)).toBe('')
})

const data = (over: Partial<LineData> = {}): LineData => ({
  label: 'B', email: 'konto-b@example.com', mode: null, style: null, dir: 'app', branch: 'main', model: 'Opus 5.5', effort: 'medium',
  view: viewOf({ lastAt: NOW - 18 * 60_000, ctx: 301_000, window: 1_000_000, model: 'claude-opus-5-5', effort: 'medium' }, NOW, '1h'),
  switched: false, warmOn: false, requests: 3, hit: 96, context: { tokens: 300_000, window: 1_000_000, percent: 30 }, advice: null,
  limits: LIMITS_B, now: NOW, total: 3.5, reset: 'auto', tzMin: 60, ...over,
})

test('the status line reads as the account line did, every field on request', () => {
  // The bare label, every field split by a middle dot, resets as a countdown.
  expect(lineOf(['account', 'email', 'model', 'effort', '5h', '7d', 'context'], data())).toBe(
    'B · konto-b@example.com · Opus 5.5 · medium · 5h 34% 1h 40m · 7d 55% 1d 14h · ctx 30%',
  )
  expect(lineOf(['cache', 'next', 'ifcold', 'hit', 'session', 'dir', 'branch', 'mode'], data({ mode: 'plan' }))).toBe(
    '● Warm 42m · next $0.06 · if cold $2.41 · hit 96% · $3.50 · app · ⎇ main · plan',
  )
  expect(lineOf(['7d'], data({ reset: 'countdown' }))).toBe('7d 55% 1d 14h')
  expect(lineOf(['5h', '7d'], data({ reset: 'clock' }))).toBe('5h 34% (14:40) · 7d 55% (Mon 03:00)')
  expect(lineOf(['7d'], data({ reset: 'both' }))).toBe('7d 55% 1d 14h (Mon 03:00)')
  // The compact hint shows only when there is advice.
  expect(lineOf(['context', 'compact'], data())).toBe('ctx 30%')
  expect(lineOf(['context', 'compact'], data({ advice: 'auto-compact at 33%' }))).toBe('ctx 30% · compact?')
  // Nothing true to show is left out, never guessed.
  expect(lineOf(['email', 'style', 'spend', 'account'], data({ email: null }))).toBe('B')
})

test('the Alfred reading carries limits, context and model, never the e-mail', () => {
  const body = alfredBody({ configDir: `${HOME}/.claude-b`, session: 's', model: 'claude-opus-5-5', limits: LIMITS_B, context: { tokens: 300_000, window: 1_000_000, percent: 30 } })
  expect(body).toEqual({
    zrodlo: 'statusline',
    klient: 'vitals',
    config_dir: `${HOME}/.claude-b`,
    sesja: 's',
    model: 'claude-opus-5-5',
    rate_limits: { five_hour: { used_percentage: 34, resets_at: 1794663600 }, seven_day: { used_percentage: 55, resets_at: 1794794400 } },
    context_window: { used_percentage: 30, context_window_size: 1_000_000, total_input_tokens: 300_000 },
  })
  expect(JSON.stringify(body)).not.toContain('@')
  expect(alfredBody({ configDir: '', session: 's', model: '', limits: [], context: { window: 0 } })).toBeNull()
})

// --- the mod ---

/** The account fields the old account line had, pinned so a test can read it. */
const ACCOUNT_LINE = { statusLine: 'on', lineFields: 'account, email, model, effort, 5h, 7d, context' }

test('each account shows its own figures: B and C never share a line', options(ACCOUNT_LINE), async ($, on) => {
  const seen = world(on, { configDir: `${HOME}/.claude-b`, email: 'konto-b@example.com', limits: LIMITS_B })
  mock.clock(on, { now: NOW })
  await start($)
  const b = seen.status.at(-1)
  expect(b).toBe('B · konto-b@example.com · Opus 5.5 · medium · 5h 34% 1h 40m · 7d 55% 1d 14h · ctx 30%')
})

test('account C reads its own folder, e-mail and limits', options(ACCOUNT_LINE), async ($, on) => {
  const seen = world(on, { configDir: `${HOME}/.claude-c`, email: 'konto-c@example.com', limits: LIMITS_C })
  mock.clock(on, { now: NOW })
  await start($)
  expect(seen.status.at(-1)).toBe('C · konto-c@example.com · Opus 5.5 · medium · 7d 97% 1d 2h · ctx 30%')
})

test('in a terminal with the script the line is written for the script, with the default fields, and nothing is pinned', async ($, on) => {
  const seen = world(on, { surfaces: ['terminal'], statusLine: 'bash "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/vitals/bin/statusline.sh"', limits: LIMITS_B })
  mock.clock(on, { now: NOW })
  await start($, 'terminal')
  expect(seen.status.filter(Boolean)).toEqual([])
  // Before the first reply there is no cache, next price or compact hint to show.
  expect(seen.writes.get('/tmp/t/vitals/sess-1.line')).toBe('A · Opus 5.5 · medium · 5h 34% 1h 40m · 7d 55% 1d 14h · ctx 30% · ⎇ main')
  await step($)
  // The next measurement after the reply draws the line again.
  await $.session.measure({ changed: ['context'], startedAt: 0, context: { window: 1_000_000 }, rateLimits: LIMITS_B } as never)
  await settle($)
  expect(seen.writes.get('/tmp/t/vitals/sess-1.line')).toBe('A · Opus 5.5 · xhigh · ● Warm 1h 00m · next $0.06 · 5h 34% 1h 40m · 7d 55% 1d 14h · ctx 30% · ⎇ main')
  expect(seen.status.filter(Boolean)).toEqual([])
})

for (const [where, surface, statusLine] of [
  ['the desktop app', 'desktop', undefined],
  ['a terminal without the script', 'terminal', 'bash $HOME/Development/alfred-app/scripts/statusline.sh'],
] as const) {
  test(`statusLine auto pins nothing in ${where}, and nothing is written`, async ($, on) => {
    const seen = world(on, { surfaces: [surface], ...(statusLine ? { statusLine } : {}), limits: LIMITS_B })
    mock.clock(on, { now: NOW })
    await start($, surface)
    await step($)
    await settle($)
    expect(seen.status.filter(Boolean)).toEqual([])
    expect(seen.writes.size).toBe(0)
    expect(await cache($, 'line')).toContain('Pinned under the prompt: auto.')
  })
}

test('statusLine off pins nothing; on pins it in a terminal with the script too', async ($, on) => {
  const seen = world(on, { surfaces: ['terminal'], statusLine: 'vitals/bin/statusline.sh' })
  mock.clock(on, { now: NOW })
  await start($, 'terminal')
  expect(seen.status.filter(Boolean)).toEqual([])
  expect(await cache($, 'line on')).toContain('pinned')
  expect(seen.status.at(-1)).toBe('A · Opus 5.5 · medium · ctx 30% · ⎇ main')
  await cache($, 'line off')
  expect(seen.status.at(-1)).toBeUndefined()
  // The terminal script still gets its line.
  expect(seen.writes.get('/tmp/t/vitals/sess-1.line')).toBe('A · Opus 5.5 · medium · ctx 30% · ⎇ main')
})

test('statusLine on in the plugin settings pins the line in the desktop app', options({ statusLine: 'on' }), async ($, on) => {
  const seen = world(on, { limits: LIMITS_B })
  mock.clock(on, { now: NOW })
  await start($)
  expect(seen.status.at(-1)).toBe('A · Opus 5.5 · medium · 5h 34% 1h 40m · 7d 55% 1d 14h · ctx 30% · ⎇ main')
  expect(seen.writes.size).toBe(0)
})

test('/cache line hide, show and set change the line and stay for the account; reset follows the settings', options({ statusLine: 'on' }), async ($, on) => {
  const seen = world(on, { limits: LIMITS_B })
  mock.clock(on, { now: NOW })
  await start($)
  expect(await cache($, 'line hide email effort')).toBe('The status line shows: account, model, cache, next, 5h, 7d, context, compact, branch.')
  expect(seen.status.at(-1)).toBe('A · Opus 5.5 · 5h 34% 1h 40m · 7d 55% 1d 14h · ctx 30% · ⎇ main')
  expect(await cache($, 'line show email')).toContain('compact, branch, email')
  expect(seen.status.at(-1)).toContain('⎇ main · konto-a@example.com')
  expect(await cache($, 'line set 7d account nonsense')).toBe('The status line shows: 7d, account. Not a field: nonsense.')
  expect(seen.status.at(-1)).toBe('7d 55% 1d 14h · A')
  expect(seen.store.get('layout')).toEqual({ band: null, line: ['7d', 'account'], status: null })
  expect(await cache($, 'line reset')).toContain('follows the plugin settings again')
  expect(seen.status.at(-1)).toBe('A · Opus 5.5 · medium · 5h 34% 1h 40m · 7d 55% 1d 14h · ctx 30% · ⎇ main')
})

test('a stored layout is the next session start', async ($, on) => {
  const seen = world(on, { limits: LIMITS_B, store: { layout: { band: null, line: ['account', 'model'], status: 'on' } } })
  mock.clock(on, { now: NOW })
  await start($)
  expect(await cache($, 'line')).toContain('Now: A · Opus 5.5\nPinned under the prompt: on.')
  expect(seen.status.at(-1)).toBe('A · Opus 5.5')
})

test('a new session shows the account last known limits before its first reply', options({ statusLine: 'on' }), async ($, on) => {
  const seen = world(on, { limits: [], store: { limits: LIMITS_B } })
  mock.clock(on, { now: NOW })
  await start($)
  expect(seen.status.at(-1)).toBe('A · Opus 5.5 · medium · 5h 34% 1h 40m · 7d 55% 1d 14h · ctx 30% · ⎇ main')
})

test('fresh limits are kept for the next session of the account', async ($, on) => {
  const seen = world(on, { limits: LIMITS_C })
  mock.clock(on, { now: NOW })
  await start($)
  await $.session.measure({ changed: ['rateLimits'], startedAt: 0, context: { window: 1_000_000 }, rateLimits: LIMITS_C } as never)
  expect(seen.store.get('limits')).toEqual(LIMITS_C)
})

test('the plugin settings choose the fields and the reset style', options({ lineFields: 'account 7d model', resetStyle: 'both', statusLine: 'on' }), async ($, on) => {
  const seen = world(on, { limits: LIMITS_B })
  mock.clock(on, { now: NOW })
  await start($)
  expect(seen.status.at(-1)).toBe('A · 7d 55% 1d 14h (Mon 03:00) · Opus 5.5')
})

test('resetStyle clock puts the status line resets on the clock', options({ lineFields: '5h 7d', resetStyle: 'clock', statusLine: 'on' }), async ($, on) => {
  const seen = world(on, { limits: LIMITS_B })
  mock.clock(on, { now: NOW })
  await start($)
  expect(seen.status.at(-1)).toBe('5h 34% (14:40) · 7d 55% (Mon 03:00)')
})

test('the band takes its fields from /cache band too', async ($, on) => {
  world(on, { limits: LIMITS_B })
  mock.clock(on, { now: NOW })
  await start($)
  await step($)
  await cache($, 'band set account model cache 7d')
  const ui = await $.ui.mount({ plugin: 'vitals', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 200, scroll: { offset: 0, bodyRows: 4 }, view: {} } } as never)
  const line = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  await ui.unmount()
  expect(line.startsWith('A  │  Opus 5.5  │  ● Cache Warm 1h 00m left  │  Weekly 55% 1d 14h')).toBe(true)
})

test('/cache fields lists every field and where each list stands', async ($, on) => {
  world(on)
  mock.clock(on, { now: NOW })
  await start($)
  const text = await cache($, 'fields')
  expect(text).toContain('Band:        cache, next, account, 5h, 7d, spend, context, compact\n')
  expect(text).toContain('Status line: account, model, effort, cache, next, 5h, 7d, context, compact, branch, pinned auto\n')
  expect(text).toContain('branch   Git branch')
})

test('the permission mode and the output style are read as the engine reports them', options({ statusLine: 'on' }), async ($, on) => {
  const seen = world(on)
  mock.clock(on, { now: NOW })
  await start($)
  await cache($, 'line set account mode style')
  await $.classic.UserPromptSubmit({ hook_event_name: 'UserPromptSubmit', session_id: 's', transcript_path: '/t', cwd: '/work/app', prompt: 'hi', permission_mode: 'plan' } as never)
  await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], outputStyle: { name: 'Explanatory', isKeepingCodingInstructions: true } } as never)
  await cache($, 'line show context')
  expect(seen.status.at(-1)).toBe('A · plan · Style Explanatory · ctx 30%')
})

// --- Alfred ---

test('Alfred is off by default: nothing is sent', async ($, on) => {
  const seen = world(on, { limits: LIMITS_B })
  mock.clock(on, { now: NOW })
  await start($)
  await $.session.measure({ changed: ['rateLimits'], startedAt: 0, context: { window: 1_000_000 }, rateLimits: LIMITS_B } as never)
  expect(seen.posts.length).toBe(0)
})

test('with Alfred on the usage goes to the local engine once a minute, with its local token and no e-mail', options({ alfred: 'on' }), async ($, on) => {
  const seen = world(on, { configDir: `${HOME}/.claude-b`, email: 'konto-b@example.com', limits: LIMITS_B })
  const clock = mock.clock(on, { now: NOW })
  await start($)
  await settle($)
  expect(seen.posts.length).toBe(1)
  const post = seen.posts[0]!
  expect(post.url).toBe('http://127.0.0.1:8765/api/konta/uzycie')
  expect(post.headers['X-Alfred-Local-Token']).toBe('local-token')
  const body = JSON.parse(post.body) as Record<string, unknown>
  expect(body.config_dir).toBe(`${HOME}/.claude-b`)
  expect(body.sesja).toBe('sess-1')
  expect(post.body).not.toContain('example.com')
  // Within the minute nothing more goes; after it, the next measurement sends again.
  await $.session.measure({ changed: ['context'], startedAt: 0, context: { window: 1_000_000 }, rateLimits: LIMITS_B } as never)
  await settle($)
  expect(seen.posts.length).toBe(1)
  await clock.advance(61_000)
  await $.session.measure({ changed: ['context'], startedAt: 0, context: { window: 1_000_000 }, rateLimits: LIMITS_B } as never)
  await settle($)
  expect(seen.posts.length).toBe(2)
})

test('an Alfred that is down never holds the session, and the pane says so', options({ alfred: 'on' }), async ($, on) => {
  world(on, { limits: LIMITS_B, alfredUp: false })
  mock.clock(on, { now: NOW })
  await start($)
  await settle($)
  const ui = await $.ui.mount({ plugin: 'vitals', component: 'Pane', requestId: 'vitals', surface: 'desktop', props: { title: 'Prompt Cache', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as never)
  // The account is on the Now tab, the Alfred card on Settings.
  expect(await ui.find({ type: 'Text', text: /konto-a@example.com/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Alfred' })).toBeUndefined()
  await ui.press({ key: 'tab-settings' })
  const all = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(all).toContain('Alfred')
  expect(all.some(t => t.startsWith('Not sent') && t.includes('ECONNREFUSED'))).toBe(true)
  await ui.unmount()
})

test('other plugins read the session from $.vitals, never the e-mail', async () => {
  const who = { label: 'B', configDir: `${HOME}/.claude-b`, email: 'konto-b@example.com', model: 'claude-opus-5-5', effort: 'medium' }
  const view = viewOf({ lastAt: NOW - 18 * 60_000, ctx: 301_000, window: 1_000_000, model: 'claude-opus-5-5', effort: 'medium' }, NOW, '1h')
  const st = { requests: 4, read: 960, write: 20, uncached: 20, output: 50, savedUsd: 1, coldWrites: 0, coldUsd: 0, last: null }
  const snap = shareOf({ now: NOW, ttl: '1h', view, who, live: { tokens: 300_000, window: 1_000_000 }, share: 30, autoAt: 92, info: { autoOn: true }, advice: null, ls: LIMITS_B, st, total: 3.5 }, 'sess-1')
  expect(snap.account).toEqual({ label: 'B', configDir: `${HOME}/.claude-b` })
  expect(snap.cache.state).toBe('warm')
  expect(snap.cache.leftMs).toBe(42 * 60_000)
  expect(snap.context).toEqual({ tokens: 301_000, window: 1_000_000, percent: 30, autoCompactOn: true, autoCompactAtPercent: 92, advice: null })
  expect(snap.limits.map(l => l.kind)).toEqual(['five_hour', 'seven_day'])
  expect(snap.session).toEqual({ requests: 4, hitPercent: 96, usd: 3.5 })
  expect(JSON.stringify(snap)).not.toContain('example.com')
  setLatest(snap)
  expect(await meterApi().snapshot()).toEqual(snap)
})

test('the old /cache answers as /vitals does', async ($, on) => {
  world(on, { limits: LIMITS_B })
  mock.clock(on, { now: NOW })
  await start($)
  const viaOld = ((await $.command.run({ command: 'cache', args: 'fields' } as never)) as { text?: string }).text ?? ''
  const viaNew = ((await $.command.run({ command: 'vitals', args: 'fields' } as never)) as { text?: string }).text ?? ''
  expect(viaOld).toContain('Band:')
  expect(viaOld).toBe(viaNew)
})
