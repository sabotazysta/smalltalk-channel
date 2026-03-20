#!/usr/bin/env bun
/**
 * Integration test suite for smalltalk-channel MCP plugin.
 *
 * Tests the MCP server via JSON-RPC over stdio, against a live Ergo instance.
 * Run with: bun run tests/integration.ts
 *
 * Prerequisites: Ergo running on 127.0.0.1:6667 with accounts bandit/scout/forge
 */

import { spawn } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'

const SERVER_PATH = join(import.meta.dir, '../src/server.ts')
const TIMEOUT_MS = 10_000

// ─── helpers ────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures: string[] = []

function ok(name: string, result: boolean, detail = '') {
  if (result) {
    console.log(`  ✅ ${name}`)
    passed++
  } else {
    console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`)
    failed++
    failures.push(name)
  }
}

/** runMcp with custom initial delay before sending messages. */
async function runMcpWithDelay(nick: string, messages: object[], opts: { port?: string; tls?: string; delay?: number } = {}): Promise<object[]> {
  const delay = opts.delay ?? 3000
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      IRC_NICK: nick,
      IRC_USERNAME: nick,
      IRC_PASSWORD: `${nick}-irc-2024!`,
      IRC_HOST: '127.0.0.1',
      IRC_PORT: opts.port ?? '6667',
      IRC_CHANNELS: '#general,#gate',
      IRC_TLS: opts.tls ?? 'false',
      IRC_GATE_CHANNEL: '#gate',
    }

    const { spawn } = require('child_process')
    const proc = spawn('bun', ['run', SERVER_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] })

    const responses: object[] = []
    let buf = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try { responses.push(JSON.parse(line)) } catch {}
      }
    })

    const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve(responses) }, TIMEOUT_MS)
    proc.on('close', () => { clearTimeout(timer); resolve(responses) })

    setTimeout(() => {
      for (const msg of messages) proc.stdin.write(JSON.stringify(msg) + '\n')
      setTimeout(() => proc.kill('SIGTERM'), 2000)
    }, delay)
  })
}

/** Spawn the MCP server and send a sequence of JSON-RPC messages, collect responses. */
async function runMcp(nick: string, messages: object[], opts: { port?: string; tls?: string } = {}): Promise<object[]> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      IRC_NICK: nick,
      IRC_USERNAME: nick,
      IRC_PASSWORD: `${nick}-irc-2024!`,
      IRC_HOST: '127.0.0.1',
      IRC_PORT: opts.port ?? '6667',
      IRC_CHANNELS: '#general,#gate',
      IRC_TLS: opts.tls ?? 'false',
      IRC_GATE_CHANNEL: '#gate',
    }

    const proc = spawn('bun', ['run', SERVER_PATH], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const responses: object[] = []
    let buf = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          responses.push(JSON.parse(line))
        } catch {}
      }
    })

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      resolve(responses)
    }, TIMEOUT_MS)

    proc.on('close', () => {
      clearTimeout(timer)
      resolve(responses)
    })

    // Wait for connection then send messages
    setTimeout(() => {
      for (const msg of messages) {
        proc.stdin.write(JSON.stringify(msg) + '\n')
      }
      // Give time for responses then kill
      setTimeout(() => proc.kill('SIGTERM'), 2000)
    }, 3000)
  })
}

/** Get the result for a given JSON-RPC id from responses. */
function getResult(responses: object[], id: number): { result?: Record<string, unknown>; error?: Record<string, unknown> } | null {
  return (responses.find((r: any) => r.id === id) as any) ?? null
}

// ─── test cases ─────────────────────────────────────────────────────────────

async function testInitialize() {
  console.log('\n[1] Initialize')
  const responses = await runMcp('bandit', [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    }},
  ])

  const init = getResult(responses, 1) as any
  ok('returns protocolVersion', init?.result?.protocolVersion === '2024-11-05')
  ok('has claude/channel capability', !!init?.result?.capabilities?.experimental?.['claude/channel'])
  ok('has tools capability', !!init?.result?.capabilities?.tools)
  ok('serverInfo.name is smalltalk', init?.result?.serverInfo?.name === 'smalltalk')
  ok('instructions mention notification tiers', (init?.result?.instructions as string)?.includes('HIGH PRIORITY'))
}

async function testListTools() {
  console.log('\n[2] List tools')
  const responses = await runMcp('bandit', [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' },
    }},
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ])

  const toolsRes = getResult(responses, 2) as any
  const tools: string[] = toolsRes?.result?.tools?.map((t: any) => t.name) ?? []
  ok('has send tool', tools.includes('send'))
  ok('has fetch_history tool', tools.includes('fetch_history'))
  ok('has who tool', tools.includes('who'))
  ok('has dm tool', tools.includes('dm'))
  ok('has list_channels tool', tools.includes('list_channels'))
}

async function testSend() {
  console.log('\n[3] Send message to #general')
  const responses = await runMcp('bandit', [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' },
    }},
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'send',
      arguments: { channel: '#general', text: `integration-test-${Date.now()}` },
    }},
  ])

  const res = getResult(responses, 2) as any
  ok('send returns ok', res?.result?.content?.[0]?.text === 'sent to #general')
  ok('no error', !res?.result?.isError)
}

async function testSendMissingArgs() {
  console.log('\n[4] Send with missing args')
  const responses = await runMcp('bandit', [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' },
    }},
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'send',
      arguments: { channel: '#general' }, // missing text
    }},
  ])

  const res = getResult(responses, 2) as any
  ok('returns isError', res?.result?.isError === true)
  ok('error mentions required args', res?.result?.content?.[0]?.text?.includes('required'))
}

async function testWho() {
  console.log('\n[5] Who — list users in #general')
  const responses = await runMcp('bandit', [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' },
    }},
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'who',
      arguments: { channel: '#general' },
    }},
  ])

  const res = getResult(responses, 2) as any
  const text: string = res?.result?.content?.[0]?.text ?? ''
  ok('returns user list', text.includes('users in #general'))
  ok('bandit is in channel', text.includes('bandit'))
  ok('no error', !res?.result?.isError)
}

async function testFetchHistory() {
  console.log('\n[6] Fetch history from #general')
  // First send a message, then fetch history
  const msg = `history-test-${Date.now()}`
  const responses = await runMcp('scout', [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' },
    }},
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'send',
      arguments: { channel: '#general', text: msg },
    }},
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'fetch_history',
      arguments: { channel: '#general', limit: 10 },
    }},
  ])

  const res = getResult(responses, 3) as any
  const text: string = res?.result?.content?.[0]?.text ?? ''
  ok('returns messages', text.includes('message(s) from #general'))
  ok('contains sent message', text.includes(msg))
  ok('no error', !res?.result?.isError)
}

async function testDm() {
  console.log('\n[7] DM — direct message between agents')
  const responses = await runMcp('forge', [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' },
    }},
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'dm',
      arguments: { nick: 'bandit', text: 'test DM from forge' },
    }},
  ])

  const res = getResult(responses, 2) as any
  ok('DM sent ok', res?.result?.content?.[0]?.text === 'DM sent to bandit')
  ok('no error', !res?.result?.isError)
}

async function testUnknownTool() {
  console.log('\n[8] Unknown tool')
  const responses = await runMcp('bandit', [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' },
    }},
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'nonexistent',
      arguments: {},
    }},
  ])

  const res = getResult(responses, 2) as any
  ok('returns error for unknown tool', res?.result?.isError === true || res?.error != null)
}

async function testListChannels() {
  console.log('\n[9] List channels')
  const responses = await runMcp('bandit', [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' },
    }},
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'list_channels',
      arguments: {},
    }},
  ])

  const res = getResult(responses, 2) as any
  const text: string = res?.result?.content?.[0]?.text ?? ''
  ok('returns channel list', text.includes('joined channels'))
  ok('includes #general', text.includes('#general'))
  ok('no error', !res?.result?.isError)
}

async function testTls() {
  console.log('\n[10] TLS connection on port 6697')
  if (process.env.CI) {
    console.log('    skipped (no TLS certs in CI environment)')
    return
  }
  // TLS takes a bit longer to negotiate — give it 6s before sending messages
  const responses = await runMcpWithDelay('bandit', [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' },
    }},
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'list_channels',
      arguments: {},
    }},
  ], { port: '6697', tls: 'true', delay: 6000 })

  const init = getResult(responses, 1) as any
  const channels = getResult(responses, 2) as any
  const channelText: string = channels?.result?.content?.[0]?.text ?? ''
  ok('TLS: initialize succeeds', init?.result?.protocolVersion === '2024-11-05')
  ok('TLS: list_channels responds', channelText.length > 0 && !channels?.result?.isError)
}

async function testNotifications() {
  console.log('\n[11] Notifications — inbound IRC messages delivered as MCP notifications')
  // Start bandit's server and watch for notifications while scout sends a message
  return new Promise<void>((resolve) => {
    const envBandit = {
      ...process.env,
      IRC_NICK: 'bandit',
      IRC_USERNAME: 'bandit',
      IRC_PASSWORD: 'bandit-irc-2024!',
      IRC_HOST: '127.0.0.1',
      IRC_PORT: '6667',
      IRC_CHANNELS: '#general,#gate',
      IRC_TLS: 'false',
      IRC_GATE_CHANNEL: '#gate',
    }

    const proc = spawn('bun', ['run', SERVER_PATH], { env: envBandit, stdio: ['pipe', 'pipe', 'pipe'] })

    const allOutput: any[] = []
    let buf = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try { allOutput.push(JSON.parse(line)) } catch {}
      }
    })

    const uniqueMsg = `notification-test-${Date.now()}`

    // After bandit connects (3.5s), have scout send a message, then wait for notification
    setTimeout(() => {
      // Send the initialize so the server stays alive
      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      }) + '\n')

      // Scout sends a @bandit mention to #general (should arrive as HIGH priority notification)
      setTimeout(async () => {
        const scoutEnv = {
          ...process.env,
          IRC_NICK: 'scout', IRC_USERNAME: 'scout', IRC_PASSWORD: 'scout-irc-2024!',
          IRC_HOST: '127.0.0.1', IRC_PORT: '6667', IRC_CHANNELS: '#general,#gate',
          IRC_TLS: 'false', IRC_GATE_CHANNEL: '#gate',
        }
        const scout = spawn('bun', ['run', SERVER_PATH], { env: scoutEnv, stdio: ['pipe', 'pipe', 'pipe'] })
        setTimeout(() => {
          scout.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }) + '\n')
          scout.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: 'send', arguments: { channel: '#general', text: `@bandit ${uniqueMsg}` } } }) + '\n')
          setTimeout(() => scout.kill('SIGTERM'), 2000)
        }, 3500)

        // Wait 10s total for notification to arrive
        await new Promise(r => setTimeout(r, 8_000))
        proc.kill('SIGTERM')

        const notifications = allOutput.filter((r: any) => r.method === 'notifications/message')
        const channelNotifs = allOutput.filter((r: any) => r.method === 'notifications/claude/channel')
        const anyNotif = [...notifications, ...channelNotifs]

        const mentionNotif = anyNotif.find((n: any) => {
          const text = JSON.stringify(n)
          return text.includes(uniqueMsg) || text.includes('MENTION')
        })

        ok('bandit receives notification when mentioned', !!mentionNotif)
        ok('notification has high priority', mentionNotif?.params?.meta?.priority === 'high' ||
           JSON.stringify(mentionNotif)?.includes('high'))
        resolve()
      }, 500)
    }, 3500)
  })
}

async function testReconnection() {
  console.log('\n[11] Reconnection — restart ergo and verify rejoin')
  // We'll run the server, let it connect, restart ergo, then verify it reconnects
  return new Promise<void>((resolve) => {
    const env = {
      ...process.env,
      IRC_NICK: 'scout',
      IRC_USERNAME: 'scout',
      IRC_PASSWORD: 'scout-irc-2024!',
      IRC_HOST: '127.0.0.1',
      IRC_PORT: '6667',
      IRC_CHANNELS: '#general,#gate',
      IRC_TLS: 'false',
      IRC_GATE_CHANNEL: '#gate',
    }
    const { spawn } = require('child_process')
    const proc = spawn('bun', ['run', SERVER_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] })

    const stderrLines: string[] = []
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrLines.push(chunk.toString())
    })

    // Wait for initial connection (3s), restart ergo (docker restart), wait for reconnect (10s)
    setTimeout(async () => {
      // Restart ergo container
      const { execSync } = require('child_process')
      try {
        execSync('docker restart smalltalk-ergo', { stdio: 'pipe' })
        console.log('    ergo restarted')
      } catch (e) {
        console.log('    warning: could not restart ergo:', String(e))
      }

      // Wait for reconnect (up to 20s)
      await new Promise(r => setTimeout(r, 15_000))
      proc.kill('SIGTERM')

      const allStderr = stderrLines.join('')
      const reconnected = allStderr.includes('reconnecting') || allStderr.includes('connected as scout')
      const rejoined = allStderr.includes('joined #general') && stderrLines.filter(l => l.includes('joined #general')).length >= 2

      ok('emits reconnecting event', allStderr.includes('reconnecting') || allStderr.includes('manual reconnect'))
      ok('rejoins #general after restart', rejoined || allStderr.split('joined #general').length >= 3)
      resolve()
    }, 3_000)
  })
}

// ─── main ───────────────────────────────────────────────────────────────────

console.log('=== smalltalk-channel integration tests ===')
console.log(`Server: ${SERVER_PATH}`)
console.log(`IRC: 127.0.0.1:6667`)

try {
  await testInitialize()
  await testListTools()
  await testSend()
  await testSendMissingArgs()
  await testWho()
  await testFetchHistory()
  await testDm()
  await testUnknownTool()
  await testListChannels()
  await testTls()
  await testNotifications()
  await testReconnection()
} catch (err) {
  console.error('Test runner error:', err)
  process.exit(1)
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
if (failures.length > 0) {
  console.log('Failed:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('All tests passed! 🎉')
