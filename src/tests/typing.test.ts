// Unit tests for the IRCv3 `+typing` delivery-receipt logic in ../typing.
// Run: bun test src/tests/typing.test.ts

import { test, expect, describe } from 'bun:test'
import { TypingTracker, isServiceNick, defaultShouldAck, type TypingClient } from '../typing'

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

  test('timeout -> paused once, entry deleted; a late reply sends nothing', async () => {
    const { client, sent } = fakeClient()
    const t = new TypingTracker({ enabled: true, pausedAfterMs: 20 })
    t.onDmReceived(client, 'pony', 'jedrzej')
    await sleep(60)
    expect(sent).toEqual([
      ['jedrzej', { '+typing': 'active' }],
      ['jedrzej', { '+typing': 'paused' }],
    ])
    expect(t.pendingCount()).toBe(0)
    t.onReplySent(client, 'jedrzej')
    expect(sent.length).toBe(2)
  })

  test('rate limit: burst of DMs -> one active, timer still resets', async () => {
    const { client, sent } = fakeClient()
    const t = new TypingTracker({ enabled: true, pausedAfterMs: 40 })
    t.onDmReceived(client, 'pony', 'jedrzej')
    t.onDmReceived(client, 'pony', 'jedrzej')
    t.onDmReceived(client, 'pony', 'jedrzej')
    expect(sent.map(s => s[1]['+typing'])).toEqual(['active'])
    await sleep(25)
    t.onDmReceived(client, 'pony', 'jedrzej') // <2 s: skipped, but resets the 40 ms timer
    await sleep(25)
    expect(sent.map(s => s[1]['+typing'])).toEqual(['active'])
    await sleep(30)
    expect(sent.map(s => s[1]['+typing'])).toEqual(['active', 'paused'])
  })

  test('rate limit: active again once the interval has passed', async () => {
    const { client, sent } = fakeClient()
    const t = new TypingTracker({ enabled: true, activeMinIntervalMs: 20 })
    t.onDmReceived(client, 'pony', 'jedrzej')
    await sleep(30)
    t.onDmReceived(client, 'pony', 'jedrzej')
    expect(sent.map(s => s[1]['+typing'])).toEqual(['active', 'active'])
    t.onReplySent(client, 'jedrzej')
  })

  test('rate limit is per nick', () => {
    const { client, sent } = fakeClient()
    const t = new TypingTracker({ enabled: true })
    t.onDmReceived(client, 'pony', 'jedrzej')
    t.onDmReceived(client, 'pony', 'bandit')
    expect(sent.map(s => s[0])).toEqual(['jedrzej', 'bandit'])
    t.onReplySent(client, 'jedrzej')
    t.onReplySent(client, 'bandit')
  })

  test('shouldAck override is the first check and replaces the defaults', () => {
    const { client, sent } = fakeClient()
    const asked: string[] = []
    const t = new TypingTracker({
      enabled: true,
      shouldAck: (nick) => { asked.push(nick); return nick === 'NickServ' },
    })
    t.onDmReceived(client, 'pony', 'jedrzej')  // rejected by the override
    t.onDmReceived(client, 'pony', 'NickServ') // allowed by the override
    expect(asked).toEqual(['jedrzej', 'NickServ'])
    expect(sent).toEqual([['NickServ', { '+typing': 'active' }]])
    t.onReplySent(client, 'NickServ')
  })

  test('throwing shouldAck -> nothing, no throw', () => {
    const { client, sent } = fakeClient()
    const t = new TypingTracker({ enabled: true, shouldAck: () => { throw new Error('boom') } })
    expect(() => t.onDmReceived(client, 'pony', 'jedrzej')).not.toThrow()
    expect(sent).toEqual([])
  })

  test('a new DM resets the paused timer', async () => {
    const { client, sent } = fakeClient()
    const t = new TypingTracker({ enabled: true, pausedAfterMs: 40, activeMinIntervalMs: 10 })
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

describe('defaultShouldAck', () => {
  test('rejects self (case-insensitive), services, server names; accepts people', () => {
    expect(defaultShouldAck('Pony', 'pony')).toBe(false)
    expect(defaultShouldAck('NickServ', 'pony')).toBe(false)
    expect(defaultShouldAck('irc.hanza.local', 'pony')).toBe(false)
    expect(defaultShouldAck('jedrzej', 'pony')).toBe(true)
  })
})
