// Unit tests for IRCv3 `draft/multiline` receive support in ../multiline.
//
// Bug (2026-11-15, live): Hanza Talk sends a long paragraph as a draft/multiline batch; without the
// cap ergo split it and the agent got "...Plików samej " and "gry nie bierzmy..." as two
// notifications. These tests drive a REAL irc-framework Client (no socket) with raw server lines,
// so they exercise irc-framework's own batch buffering/replay, not a mock of it.
//
// Run: bun test src/tests/multiline.test.ts

import { test, expect, describe } from 'bun:test'
import IRC from 'irc-framework'
import { attachMultiline, appendMultilinePiece, NESTED_MULTILINE_TAG, type MsgEvent } from '../multiline'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function setup(opts: { timeoutMs?: number; maxBytes?: number } = {}) {
  const client: any = new IRC.Client()
  const delivered: MsgEvent[] = []
  const ml = attachMultiline(client, e => delivered.push(e), opts)
  // Same path as irc-framework's own client.connection 'message' handler (client.js).
  client.on('privmsg', (e: MsgEvent) => { if (!ml.offer(e)) delivered.push(e) })
  const feed = (...lines: string[]) => {
    for (const line of lines) {
      const m = IRC.ircLineParser(line)
      client.raw_middleware.handle([m.command, m, line, client], () => client.command_handler.dispatch(m))
    }
  }
  return { client, delivered, ml, feed }
}

// Mention check, same regex as server.ts isMention (server.ts can't be imported from a test).
function isMention(text: string, nick: string): boolean {
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s|@)${escaped}(?:\\s|[,:!?]|$)`, 'i').test(text)
}

describe('appendMultilinePiece', () => {
  test('concat tag appends with no separator', () => {
    expect(appendMultilinePiece('samej ', 'gry', { 'draft/multiline-concat': '' })).toBe('samej gry')
  })
  test('no tag joins with \\n', () => {
    expect(appendMultilinePiece('a', 'b', {})).toBe('a\nb')
    expect(appendMultilinePiece('a', 'b')).toBe('a\nb')
  })
})

describe('draft/multiline batches', () => {
  test('concat in the middle of a word -> one message, no separator (channel)', () => {
    const { delivered, feed } = setup()
    feed(
      '@time=2026-11-15T10:00:00.000Z;msgid=abc123;account=jedrzej BATCH +ml1 draft/multiline #general',
      '@batch=ml1 :jedrzej!u@h PRIVMSG #general :Plików samej ',
      '@batch=ml1;draft/multiline-concat :jedrzej!u@h PRIVMSG #general :gry nie bierzmy',
      'BATCH -ml1',
    )
    expect(delivered.length).toBe(1)
    const e = delivered[0]
    expect(e.message).toBe('Plików samej gry nie bierzmy')
    expect(e.target).toBe('#general')
    expect(e.nick).toBe('jedrzej')
    // BATCH-line tags are carried onto the combined message
    expect(e.tags?.msgid).toBe('abc123')
    expect(e.tags?.account).toBe('jedrzej')
    expect(e.time).toBe(Date.parse('2026-11-15T10:00:00.000Z') as any)
  })

  test('plain lines are joined with \\n; first line tags win over BATCH tags', () => {
    const { delivered, feed } = setup()
    feed(
      '@msgid=batchid BATCH +ml2 draft/multiline #general',
      '@batch=ml2;msgid=lineid;+draft/reply=parent1 :a!u@h PRIVMSG #general :line one',
      '@batch=ml2 :a!u@h PRIVMSG #general :line two',
      '@batch=ml2 :a!u@h PRIVMSG #general :line three',
      'BATCH -ml2',
    )
    expect(delivered.map(e => e.message)).toEqual(['line one\nline two\nline three'])
    expect(delivered[0].tags?.msgid).toBe('lineid')
    expect(delivered[0].tags?.['+draft/reply']).toBe('parent1')
  })

  test('batch in a DM', () => {
    const { delivered, feed } = setup()
    feed(
      'BATCH +dm1 draft/multiline pony',
      '@batch=dm1 :jedrzej!u@h PRIVMSG pony :hej, ',
      '@batch=dm1;draft/multiline-concat :jedrzej!u@h PRIVMSG pony :to jest jedna wiadomosc',
      '@batch=dm1 :jedrzej!u@h PRIVMSG pony :druga linia',
      'BATCH -dm1',
    )
    expect(delivered.length).toBe(1)
    expect(delivered[0].target).toBe('pony')
    expect(delivered[0].message).toBe('hej, to jest jedna wiadomosc\ndruga linia')
  })

  test('mention inside the second piece is in the one delivered message', () => {
    const { delivered, feed } = setup()
    feed(
      'BATCH +m1 draft/multiline #dev',
      '@batch=m1 :a!u@h PRIVMSG #dev :dlugi wstep bez nicka',
      '@batch=m1 :a!u@h PRIVMSG #dev :pony: zerknij na to',
      'BATCH -m1',
    )
    expect(delivered.length).toBe(1)
    expect(isMention(delivered[0].message, 'pony')).toBe(true)
    expect(isMention('dlugi wstep bez nicka', 'pony')).toBe(false)
  })

  test('non-batch messages pass straight through, untouched', () => {
    const { delivered, feed } = setup()
    feed(':a!u@h PRIVMSG #general :zwykla wiadomosc')
    expect(delivered.length).toBe(1)
    expect(delivered[0].message).toBe('zwykla wiadomosc')
    expect(delivered[0].batch).toBeUndefined()
  })

  test('lost BATCH end: partial batch is flushed after the timeout', async () => {
    const { delivered, feed, client } = setup({ timeoutMs: 50 })
    feed(
      'BATCH +lost draft/multiline #general',
      '@batch=lost :a!u@h PRIVMSG #general :pierwsza ',
      '@batch=lost;draft/multiline-concat :a!u@h PRIVMSG #general :czesc',
    )
    expect(delivered.length).toBe(0)
    await sleep(120)
    expect(delivered.map(e => e.message)).toEqual(['pierwsza czesc'])
    expect(client.command_handler.hasCache('batch.lost')).toBe(false)
    // A late BATCH end is ignored by irc-framework (no cache) -> no duplicate
    feed('BATCH -lost')
    expect(delivered.length).toBe(1)
  })

  test('normal BATCH end cancels the timeout (no duplicate later)', async () => {
    const { delivered, feed } = setup({ timeoutMs: 50 })
    feed(
      'BATCH +ok draft/multiline #general',
      '@batch=ok :a!u@h PRIVMSG #general :x',
      'BATCH -ok',
    )
    await sleep(120)
    expect(delivered.length).toBe(1)
  })

  test('socket close (reset) flushes a pending batch', () => {
    const { delivered, feed, ml } = setup()
    feed('BATCH +sc draft/multiline #general', '@batch=sc :a!u@h PRIVMSG #general :zostalo')
    ml.reset()
    expect(delivered.map(e => e.message)).toEqual(['zostalo'])
  })

  test('size cap: over maxBytes splits instead of buffering without bound', () => {
    const { delivered, feed } = setup({ maxBytes: 10 })
    feed(
      'BATCH +big draft/multiline #general',
      '@batch=big :a!u@h PRIVMSG #general :12345',
      '@batch=big;draft/multiline-concat :a!u@h PRIVMSG #general :6789',
      '@batch=big;draft/multiline-concat :a!u@h PRIVMSG #general :abc',
      'BATCH -big',
    )
    expect(delivered.map(e => e.message)).toEqual(['123456789', 'abc'])
  })

  test('multiline nested in chathistory: lines are no longer dropped, carry the inner id', () => {
    // irc-framework drops lines of a nested batch on its own; the middleware re-tags them.
    const { delivered, feed } = setup()
    feed(
      'BATCH +h1 chathistory #general',
      '@batch=h1;time=2026-11-15T09:00:00.000Z;msgid=m-old :b!u@h PRIVMSG #general :zwykla',
      '@batch=h1;time=2026-11-15T09:01:00.000Z;msgid=m-ml BATCH +in1 draft/multiline #general',
      '@batch=in1 :a!u@h PRIVMSG #general :samej ',
      '@batch=in1;draft/multiline-concat :a!u@h PRIVMSG #general :gry',
      '@batch=h1 BATCH -in1',
      'BATCH -h1',
    )
    expect(delivered.map(e => e.message)).toEqual(['zwykla', 'samej ', 'gry'])
    expect(delivered.every(e => e.batch?.type === 'chathistory')).toBe(true)
    expect(delivered[0].tags?.[NESTED_MULTILINE_TAG]).toBeUndefined()
    expect(delivered[1].tags?.[NESTED_MULTILINE_TAG]).toBe('in1')
    expect(delivered[2].tags?.[NESTED_MULTILINE_TAG]).toBe('in1')
    expect(delivered[1].tags?.msgid).toBe('m-ml')
    // server.ts joins consecutive same-id entries with appendMultilinePiece:
    expect(appendMultilinePiece(delivered[1].message, delivered[2].message, delivered[2].tags)).toBe('samej gry')
  })
})
