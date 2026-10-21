import { describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'

const clients: FakeClient[] = []
class FakeClient extends EventEmitter {
  options: Record<string, unknown> = {}
  connectCalls = 0
  constructor() { super(); clients.push(this) }
  requestCap() {}
  connect() { this.connectCalls++ }
  quit() {}
  end() {}
}
mock.module('irc-framework', () => ({ default: { Client: FakeClient } }))
mock.module('irc-framework/src/transports/websocket.js', () => ({ default: {} }))

const { ConnectionPool } = await import('../connection-pool.ts')
const cfg = { host: 'irc.test', port: 443, nick: 'bandit', password: 'x' }
const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

async function makePool() {
  clients.length = 0
  const pool = new ConnectionPool()
  pool.baseWaitMs = 10
  const reconnecting: number[] = []
  pool.onReconnecting = (_c, e) => reconnecting.push(e.attempt)
  await pool.connect(cfg)
  return { pool, reconnecting }
}

describe('reconnect after close', () => {
  test('registered then closed at 0s (irc-framework abandons) -> reconnect scheduled', async () => {
    const { pool, reconnecting } = await makePool()
    const c = clients[0]
    c.emit('registered')
    c.emit('socket close')
    c.emit('close', false) // library gave up
    expect(reconnecting.length).toBe(1)
    await tick(1100)
    expect(clients.length).toBe(2)
    expect(clients[1].connectCalls).toBe(1)
    expect(pool.size()).toBe(1)
  })

  test('close without prior registration also reconnects, once', async () => {
    const { reconnecting } = await makePool()
    clients[0].emit('close', false)
    clients[0].emit('close', false) // duplicate event must not double-schedule
    expect(reconnecting.length).toBe(1)
    await tick(1100)
    expect(clients.length).toBe(2)
  })

  test('our own disconnect() never reconnects', async () => {
    const { pool, reconnecting } = await makePool()
    const c = clients[0]
    c.emit('registered')
    await pool.disconnect('irc.test')
    c.emit('close', false)
    await tick(1100)
    expect(reconnecting.length).toBe(0)
    expect(clients.length).toBe(1)
    expect(pool.size()).toBe(0)
  })

  test('watchdog forces one reconnect when stuck disconnected with no retry pending', async () => {
    const { pool } = await makePool()
    const c = clients[0]
    c.emit('registered')
    c.emit('socket close') // status disconnected, but no 'close' ever arrives
    const stuck: number[] = []
    pool.onStuck = (_c, e) => stuck.push(e.disconnectedForMs)
    pool.checkStuck(Date.now() + 6 * 60_000)
    expect(stuck.length).toBe(1)
    expect(clients.length).toBe(2)
    pool.checkStuck(Date.now() + 1000) // new conn is fresh -> no second force
    expect(clients.length).toBe(2)
  })
})
