import { expect, test } from 'claude-code/testing'

import { viewOf } from '../hooks/cache'
import type { CacheView } from '../hooks/cache'
import { adviceOf, autoPct, mcpLabel, sharePct, splitRows } from '../hooks/context'
import type { CompactFacts } from '../hooks/context'

const NOW = Date.parse('2026-11-14T12:00:00Z')
const MIN = 60 * 1000
const WINDOW = 1_000_000

/** A cache of `ctx` tokens on Opus 5.5, last written `idleMin` minutes ago. */
const view = (ctx: number, idleMin: number): CacheView =>
  viewOf({ lastAt: NOW - idleMin * MIN, ctx, window: WINDOW, model: 'claude-opus-5-5', effort: 'medium' }, NOW, '1h')
const warm = (ctx: number) => view(ctx, 10)
const cold = (ctx: number) => view(ctx, 90)

/** The engine's facts: auto-compact on at `threshold` tokens, off (false), or not known (null). */
const facts = (auto: number | false | null, tokens = 300_000): CompactFacts => ({
  context: { tokens, window: WINDOW, percent: Math.round((tokens / WINDOW) * 100) },
  autoOn: auto === null ? null : auto !== false,
  threshold: typeof auto === 'number' ? auto : null,
})

test('the share and the auto-compact threshold read as points of the window', () => {
  expect(sharePct(warm(301_000), facts(null))).toBe(30)
  // Before any reply the engine's figure stands in.
  expect(sharePct(viewOf(null, NOW, '1h'), facts(null, 450_000))).toBe(45)
  expect(sharePct(viewOf(null, NOW, '1h'), { context: { window: 0 }, autoOn: null, threshold: null })).toBeNull()
  expect(autoPct(facts(920_000))).toBe(92)
  expect(autoPct(facts(false))).toBeNull()
  expect(autoPct(facts(null))).toBeNull()
})

test('near the auto-compact threshold it says so, warm or cold', () => {
  expect(adviceOf(warm(700_000), facts(780_000), 50)).toBe('auto-compact at 78%')
  expect(adviceOf(cold(700_000), facts(780_000), 50)).toBe('auto-compact at 78%')
  // Ten points short of it is still too far.
  expect(adviceOf(warm(670_000), facts(780_000), 50)).toBeNull()
  // Before the first reply the live context counts.
  expect(adviceOf(viewOf(null, NOW, '1h'), facts(920_000, 900_000), 50)).toBe('auto-compact at 92%')
})

test('a cold cache over the coldAt share says compacting is cheap now', () => {
  expect(adviceOf(cold(600_000), facts(950_000), 50)).toBe('cache cold, context 60%')
  expect(adviceOf(cold(400_000), facts(950_000), 50)).toBeNull()
  expect(adviceOf(cold(400_000), facts(950_000), 40)).toBe('cache cold, context 40%')
  // The same context while warm is no reason.
  expect(adviceOf(warm(600_000), facts(950_000), 50)).toBeNull()
})

test('with auto-compact off it speaks up from 80%', () => {
  expect(adviceOf(warm(850_000), facts(false), 50)).toBe('context 85%, auto-compact off')
  expect(adviceOf(warm(700_000), facts(false), 50)).toBeNull()
  // Auto-compact not known is not the same as off.
  expect(adviceOf(warm(850_000), facts(null), 50)).toBeNull()
})

test('nothing to say otherwise, and nothing for a cache just compacted', () => {
  expect(adviceOf(warm(301_000), facts(950_000), 50)).toBeNull()
  expect(adviceOf(viewOf(null, NOW, '1h'), { context: { window: 0 }, autoOn: null, threshold: null }, 50)).toBeNull()
  const compacted: CacheView = { ...cold(600_000), why: 'compacted' }
  expect(adviceOf(compacted, facts(950_000), 50)).toBeNull()
  // After a break (idle time not known) a cold cache still counts.
  expect(adviceOf({ ...cold(600_000), why: 'unknown' }, facts(950_000), 50)).toBe('cache cold, context 60%')
})

test('the breakdown counts only what is in the window; deferred schemas and the reserve stand apart', () => {
  const split = splitRows([
    { name: 'MCP tools (deferred)', tokens: 623_000, kind: 'deferred', isDeferred: true },
    { name: 'Messages', tokens: 145_000, kind: 'used', isDeferred: false },
    { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer', isDeferred: false },
    { name: 'System tools (deferred)', tokens: 28_000, kind: 'deferred', isDeferred: true },
    { name: 'System tools', tokens: 21_000, kind: 'used', isDeferred: false },
    { name: 'Free space', tokens: 600_000, kind: 'free', isDeferred: false },
  ])
  expect(split.used).toEqual([{ name: 'Messages', tokens: 145_000 }, { name: 'System tools', tokens: 21_000 }])
  expect(split.deferred).toBe(651_000)
  expect(split.buffer).toBe(33_000)
  // An engine that stamps no kind is read from the names.
  expect(splitRows([{ name: 'MCP tools (deferred)', tokens: 10 }, { name: 'Free space', tokens: 5 }, { name: 'Skills', tokens: 3 }]).used).toEqual([{ name: 'Skills', tokens: 3 }])
})

test('an MCP server reads by its name; a connector named by an id reads by its tools', () => {
  expect(mcpLabel('claude.ai Gmail', ['mcp__claude_ai_Gmail__send'])).toBe('Gmail')
  expect(mcpLabel('linear', [])).toBe('linear')
  const notion = ['notion-search', 'notion-fetch', 'notion-create-pages'].map(t => `mcp__c965a09b-8624-4245-9fd5-d262ad9b3fd1__${t}`)
  expect(mcpLabel('c965a09b-8624-4245-9fd5-d262ad9b3fd1', notion)).toBe('Notion')
  const mixed = ['image_crop', 'image_blur', 'asset_search', 'pdf_split', 'font_search'].map(t => `mcp__019d6fa9-a44e-4212-9a9b-1a15dcb43fb2__${t}`)
  expect(mcpLabel('019d6fa9-a44e-4212-9a9b-1a15dcb43fb2', mixed)).toBe('image, asset, pdf (019d6fa9)')
  expect(mcpLabel('019d6fa9-a44e-4212-9a9b-1a15dcb43fb2', [])).toBe('Connector 019d6fa9')
})
