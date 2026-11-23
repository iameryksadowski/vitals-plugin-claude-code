import { expect, test } from 'claude-code/testing'

import { viewOf } from '../hooks/cache'
import { adviceOf } from '../hooks/context'
import { piecesOf } from '../hooks/fields'
import type { LineData } from '../hooks/fields'
import {
  asksImages, describePrompt, headBytes, imagesHeavy, noteOf, parseDescriptions, sizeOf, stripImages, tokensOf, toolImages, weighImages,
} from '../hooks/images'
import type { CompactMessage } from '../hooks/images'

const b64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes))
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
/** The opening bytes of a PNG `w` × `h`: signature, IHDR length and type, then its size. */
const png = (w: number, h: number) => b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0])
/** A JPEG `w` × `h` with an APP0 segment before its SOF0. */
const jpeg = (w: number, h: number) =>
  b64([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
const image = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })

test('an image header gives its size, and its tokens follow the API resize', () => {
  expect(sizeOf(headBytes(png(1100, 700), 64))).toEqual({ w: 1100, h: 700 })
  expect(sizeOf(headBytes(jpeg(800, 600), 64))).toEqual({ w: 800, h: 600 })
  expect(sizeOf(headBytes(b64([1, 2, 3, 4, 5, 6, 7, 8]), 64))).toBeNull()
  expect(tokensOf(1100, 700)).toBe(1027)
  // A large screenshot is scaled to about 1.15 megapixels first, so no image costs much over 1,530.
  expect(tokensOf(3024, 1964)).toBeLessThanOrEqual(1534)
  expect(tokensOf(0, 0)).toBe(1600)
})

test('the images of a conversation are counted, and the ones tools returned told apart', () => {
  const w = weighImages([
    { role: 'user', content: [{ type: 'text', text: 'look' }, image(png(1100, 700))] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [image(jpeg(800, 600))] }] },
    { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x' } }] },
  ])
  expect(w).toEqual({ count: 3, tokens: 1027 + 640 + 1600, inTools: 1 })
  expect(weighImages([{ role: 'user', content: [{ type: 'text', text: 'none' }] }])).toEqual({ count: 0, tokens: 0, inTools: 0 })
})

/** A small transcript as session.compact hands it: a Read of a screenshot, the reply about it, and a plain exchange. */
const transcript = (): CompactMessage[] => [
  { role: 'user', text: 'Read the screenshot', toolUses: [], handle: 'h1' },
  {
    role: 'assistant', text: '', handle: 'h2',
    toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/tmp/shot.png' }, result: { type: 'image', file: { base64: png(1100, 700) } }, text: '' }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', result: { type: 'image', file: { base64: 'x' } }, text: '' }], handle: 'h3' },
  { role: 'assistant', text: 'The dialog says   "Sync failed: 401".', toolUses: [], handle: 'h4' },
  { role: 'user', text: 'Thanks', toolUses: [], handle: 'h5' },
]

test('each image a tool returned is found once, with its path and the reply that followed it', () => {
  expect(toolImages(transcript())).toEqual([{ id: 't1', tool: 'Read', path: '/tmp/shot.png', said: 'The dialog says "Sync failed: 401".' }])
  expect(toolImages([{ role: 'user', text: 'hi', toolUses: [] }])).toEqual([])
})

test('the describing prompt lists the calls in order and asks for exactly that many', () => {
  const p = describePrompt([{ id: 'a', tool: 'Read', path: '/a.png', said: null }, { id: 'b', tool: 'mcp__browser__screenshot', path: null, said: null }])
  expect(p).toContain('JSON array of 2 strings')
  expect(p).toContain('1. Read /a.png')
  expect(p).toContain('2. mcp__browser__screenshot')
})

test('descriptions are taken only when the reply holds one per image', () => {
  expect(parseDescriptions('Here: ["a login form", "a chart"]', 2)).toEqual(['a login form', 'a chart'])
  expect(parseDescriptions('["only one"]', 2)).toBeNull()
  expect(parseDescriptions('no json', 1)).toBeNull()
  expect(parseDescriptions('[1, 2]', 2)).toBeNull()
})

test('stripping swaps the image for its note, rebuilds only the messages that held it, and keeps the rest whole', () => {
  const before = transcript()
  const [im] = toolImages(before)
  const note = noteOf(im!, 'A sync error dialog: "Sync failed: 401".')
  expect(note).toContain('It showed: A sync error dialog')
  expect(note).toContain('Read /tmp/shot.png again')
  const { messages, swapped } = stripImages(before, new Map([['t1', note]]))
  expect(swapped).toBe(2)
  expect(messages.length).toBe(before.length)
  // Untouched messages keep the engine's handle, so they stand as the engine has them.
  expect(messages[0]).toBe(before[0])
  expect(messages[3]).toBe(before[3])
  expect(messages[1]!.handle).toBeUndefined()
  expect(messages[1]!.toolUses[0]!.result).toBe(note)
  expect(messages[2]!.toolResults![0]!.text).toBe(note)
  expect(JSON.stringify(messages)).not.toContain('"type":"image"')
})

test('without a description the note says what the reply after it said', () => {
  const [im] = toolImages(transcript())
  expect(noteOf(im!, null)).toContain('the reply right after it said: "The dialog says "Sync failed: 401"."')
  expect(noteOf({ id: 'x', tool: 'tool', path: null, said: null }, null)).toContain('No description was made. Ask for it again')
})

test('only /compact images (or image, img) asks for the images alone', () => {
  expect(asksImages('images')).toBe(true)
  expect(asksImages(' Image ')).toBe(true)
  expect(asksImages('img')).toBe(true)
  expect(asksImages('keep the images of the login bug')).toBe(false)
  expect(asksImages(undefined)).toBe(false)
})

test('the hint names the images once they are heavy and a tenth of the context', () => {
  const NOW = Date.parse('2026-11-23T12:00:00Z')
  const warm = viewOf({ lastAt: NOW - 10 * 60_000, ctx: 200_000, window: 1_000_000, model: 'claude-opus-5-5', effort: 'medium' }, NOW, '1h')
  const facts = (tokens: number, inTools = 10) => ({ context: { tokens: 200_000, window: 1_000_000 }, autoOn: true, threshold: 900_000, images: { count: 10, tokens, inTools } })
  expect(adviceOf(warm, facts(40_000), 50)).toBe('images 40k, /compact images')
  expect(adviceOf(warm, facts(15_000), 50)).toBeNull()
  // Pasted images alone are out of /compact images' reach, so no hint names it.
  expect(adviceOf(warm, facts(40_000, 0), 50)).toBeNull()
  expect(imagesHeavy({ count: 30, tokens: 25_000, inTools: 30 }, 400_000)).toBe(false)
  expect(imagesHeavy(null, 100)).toBe(false)
})

test('the band shows the images with their tokens, and nothing without any', () => {
  const NOW = Date.parse('2026-11-23T12:00:00Z')
  const d = { view: viewOf(null, NOW, '1h'), images: { count: 12, tokens: 18_400 } } as unknown as LineData
  expect(piecesOf('images', d, false)!.map(p => p.t)).toEqual(['Images', '12', '18k'])
  expect(piecesOf('images', d, true)!.map(p => p.t)).toEqual(['img', '12 18k'])
  expect(piecesOf('images', { ...d, images: { count: 0, tokens: 0 } }, false)).toBeNull()
  expect(piecesOf('images', { ...d, images: null }, false)).toBeNull()
})
