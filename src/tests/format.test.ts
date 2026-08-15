// Unit tests for the pure formatting/timestamp helpers in server.ts — extracted 2026-08-11
// specifically so the msgid-in-fetch_history-output logic (part of the
// feature/persistent-channel-membership branch, redact tool support) has SOME real automated
// coverage, since the full MCP-tool-call path still requires a live IRC connection to exercise
// end-to-end (see CLAUDE.md's "In-progress branch" section for what's proven vs. still owed).
//
// Run: bun test src/tests/format.test.ts

import { test, expect, describe } from 'bun:test'
import { getEventTs, formatHistoryMessage } from '../format'

describe('getEventTs', () => {
  test('Date instance -> its own ISO string', () => {
    const d = new Date('2026-08-10T12:00:00.000Z')
    expect(getEventTs(d)).toBe('2026-08-10T12:00:00.000Z')
  })

  test('string input -> passed through unchanged', () => {
    expect(getEventTs('2026-08-10T12:00:00.000Z')).toBe('2026-08-10T12:00:00.000Z')
  })

  test('null/undefined -> falls back to a fresh ISO timestamp (not a crash)', () => {
    const result = getEventTs(null)
    // Can't assert an exact value (uses real time), but it must be a well-formed ISO string.
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(getEventTs(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('formatHistoryMessage', () => {
  test('with msgid: includes {msgid} inline between timestamp and nick', () => {
    const out = formatHistoryMessage({
      ts: '2026-08-10T12:00:00.000Z', nick: 'bandit', text: 'hello', msgid: 'abc123',
    })
    expect(out).toBe('[2026-08-10T12:00:00.000Z] {abc123} <bandit> hello')
  })

  test('without msgid: omits the braces entirely, no blank "{}" or "msgid="', () => {
    const out = formatHistoryMessage({
      ts: '2026-08-10T12:00:00.000Z', nick: 'bandit', text: 'hello',
    })
    expect(out).toBe('[2026-08-10T12:00:00.000Z] <bandit> hello')
    expect(out).not.toContain('{}')
    expect(out).not.toContain('msgid=')
  })

  test('empty-string msgid is treated as absent (falsy), not printed as {}', () => {
    const out = formatHistoryMessage({
      ts: '2026-08-10T12:00:00.000Z', nick: 'bandit', text: 'hello', msgid: '',
    })
    expect(out).toBe('[2026-08-10T12:00:00.000Z] <bandit> hello')
  })

  test('multiple messages join with newlines in the shape fetch_history actually returns', () => {
    const msgs = [
      { ts: '2026-08-10T12:00:00.000Z', nick: 'a', text: 'one', msgid: 'm1' },
      { ts: '2026-08-10T12:00:01.000Z', nick: 'b', text: 'two' },
    ]
    const joined = msgs.map(formatHistoryMessage).join('\n')
    expect(joined).toBe(
      '[2026-08-10T12:00:00.000Z] {m1} <a> one\n[2026-08-10T12:00:01.000Z] <b> two'
    )
  })
})
