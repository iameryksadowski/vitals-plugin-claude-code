// Images in the context: how many, what they weigh, and swapping the ones tools returned for text. Pure, no engine.

/** From this many image tokens the compact hint names the images (and only when they are a tenth of the context or more). */
export const IMAGES_AT = 20_000
/** A description kept in place of an image is cut here. */
const DESC_MAX = 600
/** What an image whose size cannot be read is taken for: the most one costs after the API's resize. */
const FALLBACK_TOKENS = 1600

export type ImageWeight = {
  /** Image blocks in the messages the next request is built from. */
  count: number
  /** Their tokens, estimated as the API counts them (width × height / 750 after its resize). */
  tokens: number
  /** Of them, the ones a tool returned: what `/compact images` can swap for text. */
  inTools: number
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i
  return t
})()

/** The first `max` bytes of base64 data, enough for an image header; no Buffer or atob needed. */
export const headBytes = (b64: string, max: number): Uint8Array => {
  const out = new Uint8Array(max)
  let n = 0, acc = 0, bits = 0
  for (let i = 0; i < b64.length && n < max; i++) {
    const c = b64.charCodeAt(i)
    const v = c < 128 ? B64_INDEX[c]! : -1
    if (v < 0) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, n)
}

/** Width and height from a PNG, GIF, WebP or JPEG header, or null. */
export const sizeOf = (b: Uint8Array): { w: number; h: number } | null => {
  const be16 = (i: number) => (b[i]! << 8) | b[i + 1]!
  const le16 = (i: number) => b[i]! | (b[i + 1]! << 8)
  const be32 = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: be32(16), h: be32(20) }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: le16(6), h: le16(8) }
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    if (kind === 'VP8X') return { w: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), h: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) }
    if (kind === 'VP8 ') return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff }
    if (kind === 'VP8L') {
      const v = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
      return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }
    }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const m = b[i + 1]!
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: be16(i + 7), h: be16(i + 5) }
      i += 2 + be16(i + 2)
    }
  }
  return null
}

/** Tokens of one image as the API counts them: resized to a long edge of 1568 and about 1.15 megapixels, then w × h / 750. */
export const tokensOf = (w: number, h: number): number => {
  if (!(w > 0 && h > 0)) return FALLBACK_TOKENS
  const s = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1_150_000 / (w * h)))
  return Math.ceil((w * s * (h * s)) / 750)
}

type Block = { type: string; [field: string]: unknown }

const imageTokens = (b: Block): number => {
  const src = b.source as { type?: string; data?: unknown } | undefined
  if (!src || typeof src.data !== 'string') return FALLBACK_TOKENS
  // PNG, GIF and WebP say their size in the first bytes; a JPEG may carry it after a long EXIF block, so only it is read further.
  const head = headBytes(src.data, 32)
  const size = sizeOf(head) ?? (head[0] === 0xff && head[1] === 0xd8 ? sizeOf(headBytes(src.data, 96 * 1024)) : null)
  return size ? tokensOf(size.w, size.h) : FALLBACK_TOKENS
}

/** How many images the messages hold and what they weigh, in Messages API form (`$.session.messages({ as: 'api' })`). */
export const weighImages = (messages: ReadonlyArray<{ role: string; content: readonly Block[] }>): ImageWeight => {
  let count = 0, tokens = 0, inTools = 0
  const walk = (blocks: readonly unknown[], inTool: boolean) => {
    for (const raw of blocks) {
      if (!raw || typeof raw !== 'object') continue
      const b = raw as Block
      if (b.type === 'image') {
        count++
        tokens += imageTokens(b)
        if (inTool) inTools++
      } else if (Array.isArray(b.content)) walk(b.content, inTool || b.type === 'tool_result')
    }
  }
  for (const m of messages) walk(m.content, false)
  return { count, tokens, inTools }
}

/** Whether a tool's recorded result holds an image block anywhere, a few levels down. Long strings are not scanned. */
export const hasImage = (v: unknown, depth = 0): boolean => {
  if (!v || typeof v !== 'object' || depth > 6) return false
  if (Array.isArray(v)) return v.some(x => hasImage(x, depth + 1))
  const o = v as Record<string, unknown>
  if (o.type === 'image') return true
  for (const k in o) if (o[k] && typeof o[k] === 'object' && hasImage(o[k], depth + 1)) return true
  return false
}

type ToolUse = { tool_use_id: string; tool: string; input?: unknown; result?: unknown; text?: string; [k: string]: unknown }
type ToolResult = { tool_use_id: string; result?: unknown; text?: string; [k: string]: unknown }
/** A message as `session.compact` hands it (SessionMessage), only the fields this file reads. */
export type CompactMessage = { role: 'user' | 'assistant'; text: string; toolUses: ToolUse[]; toolResults?: ToolResult[]; handle?: string; uuid?: string }

/** One image a tool returned: its call, for the describing prompt and the note left in its place. */
export type ToolImage = { id: string; tool: string; path: string | null; said: string | null }

const pathOf = (input: unknown): string | null => {
  if (!input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>
  for (const k of ['file_path', 'path', 'filePath', 'url']) if (typeof i[k] === 'string' && i[k]) return i[k] as string
  return null
}

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max).replace(/\s+\S*$/, '')}...`
}

/**
 * The images tools returned, oldest first, one per call; with what the reply
 * right after it said, the stand-in when no description comes back.
 */
export const toolImages = (messages: readonly CompactMessage[]): ToolImage[] => {
  const found: ToolImage[] = []
  const seen = new Set<string>()
  messages.forEach((m, i) => {
    const hits: Array<{ id: string; tool: string; input?: unknown }> = []
    for (const t of m.toolUses) if (hasImage(t.result) && !seen.has(t.tool_use_id)) hits.push({ id: t.tool_use_id, tool: t.tool, input: t.input })
    for (const t of m.toolResults ?? []) if (hasImage(t.result) && !seen.has(t.tool_use_id) && !hits.some(h => h.id === t.tool_use_id)) hits.push({ id: t.tool_use_id, tool: 'tool', input: undefined })
    if (hits.length === 0) return
    const next = messages.slice(i + 1).find(x => x.role === 'assistant' && x.text.trim())
    for (const h of hits) {
      seen.add(h.id)
      found.push({ id: h.id, tool: h.tool, path: pathOf(h.input), said: next ? oneLine(next.text, 300) : null })
    }
  })
  return found
}

/** The prompt that asks the session's own model, over its cached transcript, to describe those images. */
export const describePrompt = (images: readonly ToolImage[]): string =>
  [
    `Vitals is about to take ${images.length === 1 ? 'an image' : `${images.length} images`} out of this conversation's context to save tokens. Describe each image these tool calls returned, in this order, so the description can stand in for it: what it shows, with any text, numbers or state that matter later, in at most three sentences.`,
    `Answer with only a JSON array of ${images.length} strings, nothing else.`,
    ...images.map((im, i) => `${i + 1}. ${im.tool}${im.path ? ` ${im.path}` : ''}`),
  ].join('\n')

/** The descriptions from the reply, one per image in order, or null when it does not hold exactly that. */
export const parseDescriptions = (text: string, n: number): string[] | null => {
  const at = text.indexOf('['), end = text.lastIndexOf(']')
  if (at < 0 || end <= at) return null
  try {
    const v: unknown = JSON.parse(text.slice(at, end + 1))
    if (!Array.isArray(v) || v.length !== n || !v.every(x => typeof x === 'string')) return null
    return (v as string[]).map(s => oneLine(s, DESC_MAX))
  } catch {
    return null
  }
}

/** What stands in an image's place: what it showed, and where to read it again. */
export const noteOf = (im: ToolImage, description: string | null): string =>
  [
    '[Image removed from the context by Vitals (/compact images).',
    description ? `It showed: ${description}` : im.said ? `No description was made; the reply right after it said: "${im.said}"` : 'No description was made.',
    im.path ? `Read ${im.path} again if the detail is needed.]` : 'Ask for it again if the detail is needed.]',
  ].join(' ')

/**
 * The transcript with every image a tool returned swapped for its note. A
 * message without one stays the engine's own, whole (its handle kept); one with
 * an image is handed back rebuilt from its text and tool blocks, so the image
 * blocks are gone and the note reads in their place.
 */
export const stripImages = <M extends CompactMessage>(messages: readonly M[], notes: ReadonlyMap<string, string>): { messages: CompactMessage[]; swapped: number } => {
  let swapped = 0
  const out = messages.map((m): CompactMessage => {
    const hit = m.toolUses.some(t => notes.has(t.tool_use_id) && hasImage(t.result)) || (m.toolResults ?? []).some(t => notes.has(t.tool_use_id) && hasImage(t.result))
    if (!hit) return m
    swapped++
    const swap = <T extends { tool_use_id: string; result?: unknown; text?: string }>(t: T): T => {
      const note = notes.get(t.tool_use_id)
      if (!note || !hasImage(t.result)) return t
      const text = [typeof t.text === 'string' ? t.text.trim() : '', note].filter(Boolean).join('\n')
      return { ...t, result: text, text }
    }
    return {
      role: m.role,
      text: m.text,
      toolUses: m.toolUses.map(swap),
      ...(m.toolResults ? { toolResults: m.toolResults.map(swap) } : {}),
    }
  })
  return { messages: out, swapped }
}

/** Whether `/compact <instructions>` asks for the images alone. */
export const asksImages = (instructions: string | undefined): boolean => /^\s*(images?|img)\s*$/i.test(instructions ?? '')

/** Whether the images are worth naming in the compact hint: heavy on their own and a tenth of the context or more. */
export const imagesHeavy = (w: ImageWeight | null | undefined, contextTokens: number): boolean =>
  !!w && w.inTools > 0 && w.tokens >= IMAGES_AT && (contextTokens <= 0 || w.tokens * 10 >= contextTokens)
