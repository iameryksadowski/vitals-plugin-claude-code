import type { TimelineEntry } from '../types'

/** Markdown taken out of a message, so the timeline reads as plain words: links keep their text, headings, emphasis and code marks go. */
export const plain = (text: string): string =>
  text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/\*\*|__|`+/g, '')

/** How a message opens, for the timeline: plain words, whitespace folded, cut at a word with three dots past `max`. The pane wraps it. */
export const firstLine = (text: string, max = 180): string => {
  const one = plain(text).replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  const cut = one.slice(0, max - 3)
  const word = cut.lastIndexOf(' ')
  return `${(word > max / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:.-]+$/, '')}...`
}

/** A message without the lines it quotes (`> ...`), when it says anything of its own. */
const unquoted = (text: string): string => {
  const own = text.split('\n').filter(l => !/^\s*>/.test(l)).join('\n')
  return plain(own).trim() ? own : text
}

/** The engine's own notes inside a prompt: never something a person wrote. */
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/** What a prompt says once the engine's notes are taken out. */
const bare = (text: string): string => text.replace(REMINDER, ' ').trim()

/** The text inside the first `<tag ...>...</tag>`, and its attributes. */
const tagged = (text: string, tag: string): { attrs: string; body: string } | null => {
  const m = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)(?:</${tag}>|$)`).exec(text)
  return m ? { attrs: m[1] ?? '', body: m[2] ?? '' } : null
}

const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attrs)
  return m?.[1] ?? null
}

/** A session address as people read it: a name, or nothing when it is only a socket. */
const sessionName = (from: string | null): string | null =>
  !from || /^(uds:|\/|tcp:)/.test(from) || /\.sock$/.test(from) ? null : from

/**
 * Who sent a prompt and how it opens, for the timeline. `source` is the
 * engine's word for who injected it (`user`, `sdk`, `system`, `loop_wakeup`,
 * `schedule_wakeup`, `poll_event`); the text's own markers tell a message from
 * another session, a finished task or the app's notes apart. Null for a prompt
 * the timeline does not keep (a poll event before its delivery).
 */
export const promptEntry = (prompt: string, source: string | undefined, at: number): TimelineEntry | null => {
  if (source === 'poll_event') return null
  const base = { at, ms: null, tools: null }
  const peer = tagged(prompt, 'cross-session-message')
  if (peer) return { ...base, who: 'session', from: sessionName(attr(peer.attrs, 'from')), text: firstLine(bare(peer.body)) || null }
  const agent = tagged(prompt, 'agent-message')
  if (agent) return { ...base, who: 'agent', text: firstLine(bare(agent.body).replace(/^\s*\[[^\]]*\]\s*/, '')) || null }
  const task = tagged(prompt, 'task-notification')
  if (task) {
    const summary = tagged(task.body, 'summary')?.body ?? tagged(task.body, 'status')?.body ?? task.body.replace(/<[^>]+>/g, ' ')
    return { ...base, who: 'task', text: firstLine(summary) || null }
  }
  for (const tag of ['side-sessions-event', 'ci-monitor-event']) {
    const ev = tagged(prompt, tag)
    if (ev) return { ...base, who: 'system', text: firstLine(ev.body.replace(/<[^>]+>/g, ' ')) || null }
  }
  if (source === 'loop_wakeup' || source === 'schedule_wakeup') return { ...base, who: 'schedule', text: firstLine(bare(prompt)) || null }
  const own = bare(prompt)
  if (!own) return { ...base, who: 'system', text: firstLine(prompt.replace(/<[^>]+>/g, ' ')) || null }
  return { ...base, who: source === 'system' ? 'system' : 'you', text: firstLine(unquoted(own)) }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (n: number) => String(n).padStart(2, '0')

/** When a moment was, in the person's zone (`tzMin` east of UTC): `16:01` within the last day, `Sat 16:01` further back. */
export const stampOf = (at: number, now: number, tzMin: number): string => {
  const d = new Date(at + tzMin * 60_000)
  const hm = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
  return now - at < 20 * 3_600_000 ? hm : `${DAYS[d.getUTCDay()]} ${hm}`
}

/** How each sender reads in the timeline. */
export const WHO_NAME: Record<TimelineEntry['who'], string> = {
  you: 'You',
  claude: 'Claude',
  session: 'Session',
  agent: 'Agent',
  task: 'Task',
  schedule: 'Scheduled',
  system: 'App',
}
