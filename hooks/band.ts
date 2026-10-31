// The band's layout: parts kept by priority as the band narrows. Pure, no engine.

/** One run of text in the band, with no spaces of its own: the band puts them in. */
export type Piece = { t: string; color?: string; dim?: boolean; bold?: boolean }
/** One part of the band; the lower `prio`, the longer it stays as the band narrows. */
export type Segment = { key: string; prio: number; pieces: Piece[] }

/** Between parts. Inside a part, pieces stand one space apart. */
export const SEP = '  │  '
export const GAP = ' '

export const widthOf = (s: Segment): number =>
  s.pieces.reduce((n, p) => n + p.t.length, 0) + GAP.length * Math.max(0, s.pieces.length - 1)

/**
 * The parts that fit in `columns` with `reserve` kept free (the Details
 * button), in their reading order, taken strictly by priority. The part with the lowest priority is always
 * drawn: when it does not fit beside the reserve, the reserve goes
 * (`withReserve` false), and when it does not fit at all the surface clips it.
 */
export const fit = (segs: readonly Segment[], columns: number, reserve: number): { shown: Segment[]; withReserve: boolean } => {
  const byPrio = [...segs].sort((a, b) => a.prio - b.prio)
  const first = byPrio[0]
  if (!first) return { shown: [], withReserve: true }
  const withReserve = widthOf(first) <= columns - reserve
  const room = withReserve ? columns - reserve : columns
  const keep = new Set<string>([first.key])
  let used = widthOf(first)
  for (const s of byPrio.slice(1)) {
    const w = SEP.length + widthOf(s)
    // Strictly by priority: a part that does not fit ends the band, so a
    // smaller, less important part never takes the place of a bigger one.
    if (used + w > room) break
    keep.add(s.key)
    used += w
  }
  return { shown: segs.filter(s => keep.has(s.key)), withReserve }
}

/** A part's pieces with the single spaces between them, as the band draws them. */
export const spaced = (pieces: readonly Piece[]): Piece[] =>
  pieces.flatMap((p, i) => (i === 0 ? [p] : [{ t: GAP }, p]))
