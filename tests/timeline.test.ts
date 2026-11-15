import { expect, test } from 'claude-code/testing'

import { firstLine, promptEntry, stampOf } from '../hooks/timeline'

const AT = 1_000

test('your own words count as yours, with the engine notes taken out', () => {
  const forked = '<system-reminder>\nThis conversation was forked from another session.\n</system-reminder>\nRename the repo everywhere'
  expect(promptEntry(forked, 'user', AT)).toEqual({ at: AT, ms: null, tools: null, who: 'you', text: 'Rename the repo everywhere' })
  expect(promptEntry('Fix the login\n  bug', undefined, AT)?.who).toBe('you')
  expect(promptEntry('run the report', 'sdk', AT)?.who).toBe('you')
})

test('a prompt that is only the app speaking reads as the app, never as you', () => {
  const e = promptEntry('<system-reminder>The user has not heard from you.</system-reminder>', 'system', AT)
  expect(e?.who).toBe('system')
  expect(e?.text).toBe('The user has not heard from you.')
})

test('a message from another session names that session when it has a name, never a socket path', () => {
  const peer = promptEntry('<cross-session-message from="uds:/tmp/cc-socks/39584.sock">Final names for the plugin</cross-session-message>', 'system', AT)
  expect(peer).toEqual({ at: AT, ms: null, tools: null, who: 'session', from: null, text: 'Final names for the plugin' })
  const named = promptEntry('<cross-session-message from="alfred-docs">Docs merged</cross-session-message>', 'system', AT)
  expect(named?.from).toBe('alfred-docs')
})

test('a finished task, an app event and a scheduled prompt each read as such; a poll event is not kept', () => {
  const task = promptEntry('<task-notification><task-id>a1</task-id><status>completed</status><summary>Agent "review" finished</summary></task-notification>', 'system', AT)
  expect(task?.who).toBe('task')
  expect(task?.text).toBe('Agent "review" finished')
  expect(promptEntry('<side-sessions-event>Session X ended its turn</side-sessions-event>', 'system', AT)?.who).toBe('system')
  expect(promptEntry('check the deploy', 'schedule_wakeup', AT)?.who).toBe('schedule')
  expect(promptEntry('anything', 'poll_event', AT)).toBe(null)
})

test('a long message reads as its opening, cut with three dots', () => {
  const long = 'word '.repeat(60)
  expect(firstLine('short  one\n here')).toBe('short one here')
  const one = firstLine(long)
  expect(one.length).toBe(180)
  expect(one.endsWith('...')).toBe(true)
})

test('a moment reads as a clock time within the last day, with its weekday further back', () => {
  const at = Date.parse('2026-11-14T15:01:00Z')
  expect(stampOf(at, at + 3_600_000, 60)).toBe('16:01')
  expect(stampOf(at, at + 30 * 3_600_000, 60)).toBe('Sat 16:01')
})
