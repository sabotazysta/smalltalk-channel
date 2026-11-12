// Unit tests for the IRCv3 `+typing` delivery-receipt logic in ../typing.
// Run: bun test src/tests/typing.test.ts

import { test, expect, describe } from 'bun:test'
import { TypingTracker, isServiceNick, type TypingClient } from '../typing'

function fakeClient(caps: string[] = ['message-tags']) {
  const sent: Array<[string, Record<string, string>]> = []
  const client: TypingClient = {
    network: { cap: { isEnabled: (c: string) => caps.includes(c) } },
    tagmsg: (target, tags) => { sent.push([target, tags]) },
  }
  return { client, sent }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('TypingTracker', () => {
  test('DM in -> active sent to the sender', () => {
    const { client, sent } = fakeClient()
    const t = new TypingTracker({ enabled: true })
    t.onDmReceived(client, 'pony', 'jedrzej')
    expect(sent).toEqual([['jedrzej', { '+typing': 'active' }]])
    t.onReplySent(client, 'jedrzej') // clear timer
  })

  test('reply via dm tool -> done, and no paused afterwards', async () => {
    const { client, sent } = fakeClient()
    const t = new TypingTracker({ enabled: true, pausedAfterMs: 20 })
    t.onDmReceived(client, 'pony', 'Jedrzej')
    t.onReplySent(client, 'jedrzej')
    await sleep(40)
    expect(sent).toEqual([
      ['Jedrzej', { '+typing': 'active' }],
      ['jedrzej', { '+typing': 'done' }],
    ])
  })

  test('reply to a nick that never DMed us -> nothing', () => {
    const { client, sent } = fakeClient()
    const t = new TypingTracker({ enabled: true })
    t.onReplySent(client, 'bandit')
    t.onReplySent(client, '#general')
    expect(sent).toEqual([])
  })

  test('timeout -> paused once; later reply still sends done', async () => {
    const { client, sent } = fakeClient()
    const t = new TypingTracker({ enabled: true, pausedAfterMs: 20 })
    t.onDmReceived(client, 'pony', 'jedrzej')
    await sleep(60)
    expect(sent).toEqual([
      ['jedrzej', { '+typing': 'active' }],
      ['jedrzej', { '+typing': 'paused' }],
    ])
    t.onReplySent(client, 'jedrzej')
    expect(sent[2]).toEqual(['jedrzej', { '+typing': 'done' }])
  })

  test('a new DM resets the paused timer', async () => {
    const { client, sent } = fakeClient()
    const t = new TypingTracker({ enabled: true, pausedAfterMs: 40 })
    t.onDmReceived(client, 'pony', 'jedrzej')
    await sleep(25)
    t.onDmReceived(client, 'pony', 'jedrzej')
    await sleep(25)
    expect(sent.map(s => s[1]['+typing'])).toEqual(['active', 'active'])
    await sleep(30)
    expect(sent.map(s => s[1]['+typing'])).toEqual(['active', 'active', 'paused'])
  })

  test('channel message -> nothing (send to a channel without prior DM)', () => {
    // server.ts only calls onDmReceived on the DM branch; a channel reply via `send`
    // finds no pending entry and sends nothing.
    const { client, sent } = fakeClient()
    const t = new TypingTracker({ enabled: true })
    t.onReplySent(client, '#general')
    expect(sent).toEqual([])
  })

  test('flag off -> nothing', () => {
    const { client, sent } = fakeClient()
    const t = new TypingTracker({ enabled: false })
    t.onDmReceived(client, 'pony', 'jedrzej')
    t.onReplySent(client, 'jedrzej')
    expect(sent).toEqual([])
  })

  test('no message-tags cap -> nothing', async () => {
    const { client, sent } = fakeClient([])
    const t = new TypingTracker({ enabled: true, pausedAfterMs: 10 })
    t.onDmReceived(client, 'pony', 'jedrzej')
    await sleep(30)
    t.onReplySent(client, 'jedrzej')
    expect(sent).toEqual([])
  })

  test('self and services -> nothing', () => {
    const { client, sent } = fakeClient()
    const t = new TypingTracker({ enabled: true })
    t.onDmReceived(client, 'pony', 'Pony')
    t.onDmReceived(client, 'pony', 'NickServ')
    t.onDmReceived(client, 'pony', 'irc.hanza.local')
    expect(sent).toEqual([])
  })

  test('tagmsg throwing never propagates', () => {
    const client: TypingClient = {
      network: { cap: { isEnabled: () => true } },
      tagmsg: () => { throw new Error('socket gone') },
    }
    const t = new TypingTracker({ enabled: true })
    expect(() => t.onDmReceived(client, 'pony', 'jedrzej')).not.toThrow()
    expect(() => t.onReplySent(client, 'jedrzej')).not.toThrow()
  })
})

describe('isServiceNick', () => {
  test('services, server names and empty nick', () => {
    expect(isServiceNick('NickServ')).toBe(true)
    expect(isServiceNick('histserv')).toBe(true)
    expect(isServiceNick('irc.example.com')).toBe(true)
    expect(isServiceNick('')).toBe(true)
    expect(isServiceNick('bandit')).toBe(false)
  })
})
