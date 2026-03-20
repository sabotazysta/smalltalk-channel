#!/usr/bin/env bun
/**
 * smalltalk-channel MCP demo
 *
 * Shows two agents (scout + forge) coordinating via IRC using real MCP JSON-RPC calls.
 * Run: bun run scripts/demo-mcp.ts
 */

import { spawn } from 'child_process'
import { join } from 'path'

const SERVER = join(import.meta.dir, '../src/server.ts')

const C = {
  cyan:   '\x1b[0;36m',
  green:  '\x1b[0;32m',
  yellow: '\x1b[1;33m',
  blue:   '\x1b[0;34m',
  reset:  '\x1b[0m',
}

function log(prefix: string, msg: string) {
  console.log(`${C.yellow}${prefix}${C.reset} ${msg}`)
}

function makeEnv(nick: string) {
  return {
    ...process.env,
    IRC_NICK: nick,
    IRC_USERNAME: nick,
    IRC_PASSWORD: `${nick}-irc-2024!`,
    IRC_HOST: '127.0.0.1',
    IRC_PORT: '6667',
    IRC_CHANNELS: '#general,#gate',
    IRC_TLS: 'false',
    IRC_GATE_CHANNEL: '#gate',
  }
}

/** Call a single MCP tool on a given agent. Returns the text response. */
async function mcpCall(nick: string, tool: string, args: object): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('bun', ['run', SERVER], { env: makeEnv(nick), stdio: ['pipe', 'pipe', 'pipe'] })

    const responses: any[] = []
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

    proc.on('close', () => {
      const r = responses.find((r) => r.id === 2)
      const text: string = r?.result?.content?.[0]?.text ?? r?.error?.message ?? '(no response)'
      resolve(text)
    })

    // Wait for IRC connection, then send messages
    setTimeout(() => {
      const init = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'demo', version: '1.0' } },
      })
      const call = JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: tool, arguments: args },
      })

      proc.stdin.write(init + '\n')
      proc.stdin.write(call + '\n')

      setTimeout(() => proc.kill('SIGTERM'), 3000)
    }, 3500)
  })
}

/** Call multiple MCP tools in sequence on a given agent. Returns array of text responses (one per tool). */
async function mcpCallSeq(nick: string, calls: Array<{ tool: string; args: object }>): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn('bun', ['run', SERVER], { env: makeEnv(nick), stdio: ['pipe', 'pipe', 'pipe'] })

    const responses: any[] = []
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

    proc.on('close', () => {
      const results = calls.map((_, i) => {
        const r = responses.find((r) => r.id === i + 2)
        return r?.result?.content?.[0]?.text ?? r?.error?.message ?? '(no response)'
      })
      resolve(results)
    })

    setTimeout(() => {
      const init = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'demo', version: '1.0' } },
      })
      proc.stdin.write(init + '\n')
      for (let i = 0; i < calls.length; i++) {
        const call = JSON.stringify({
          jsonrpc: '2.0', id: i + 2, method: 'tools/call',
          params: { name: calls[i].tool, arguments: calls[i].args },
        })
        proc.stdin.write(call + '\n')
      }
      // Wait extra time for sequential tool calls to complete
      setTimeout(() => proc.kill('SIGTERM'), 4000 + calls.length * 1000)
    }, 3500)
  })
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── Demo ────────────────────────────────────────────────────────────────────

console.log('')
console.log(`${C.cyan}=== smalltalk-channel MCP demo ===${C.reset}`)
console.log('')
console.log('Two agents (scout + forge) coordinate via IRC using real MCP JSON-RPC.')
console.log('Each step is an actual tools/call request to the MCP server.')
console.log('')

log('[scout → #gate]', 'Announcing a research task...')
const sendResult = await mcpCall('scout', 'send', {
  channel: '#gate',
  text: '[TASK] Research best IRC libraries for Python. Need: irctokens vs pydle vs irc3. Priority: high.',
})
console.log(`  ${C.green}✓${C.reset} ${sendResult}`)
await sleep(500)

console.log('')
log('[forge → #gate]', 'Picking up the task...')
const ackResult = await mcpCall('forge', 'send', {
  channel: '#gate',
  text: '[ACK] On it. Will benchmark all three — back in 20.',
})
console.log(`  ${C.green}✓${C.reset} ${ackResult}`)
await sleep(500)

console.log('')
log('[forge → who]', 'Checking who\'s online in #general...')
const whoResult = await mcpCall('forge', 'who', { channel: '#general' })
console.log(`  ${C.green}✓${C.reset} ${whoResult}`)
await sleep(500)

console.log('')
log('[forge → #general]', 'Posting results...')
const resultMsg = 'Research complete. irctokens wins (parse-only, no state). pydle best for bots. irc3 for plugin architectures. Recommending irctokens.'
const postResult = await mcpCall('forge', 'send', { channel: '#general', text: resultMsg })
console.log(`  ${C.green}✓${C.reset} ${postResult}`)
await sleep(500)

console.log('')
log('[scout → fetch_history]', 'Reading what forge posted...')
const history = await mcpCall('scout', 'fetch_history', { channel: '#general', limit: 3 })
console.log(`  ${C.blue}${history}${C.reset}`)
await sleep(500)

console.log('')
log('[scout → dm forge]', 'Sending a direct message...')
const dmResult = await mcpCall('scout', 'dm', {
  nick: 'forge',
  text: 'great work, shipping the irctokens approach',
})
console.log(`  ${C.green}✓${C.reset} ${dmResult}`)
await sleep(500)

console.log('')
log('[scout → list_channels]', 'Listing joined channels...')
const channelsResult = await mcpCall('scout', 'list_channels', {})
console.log(`  ${C.green}✓${C.reset} ${channelsResult}`)
await sleep(500)

console.log('')
log('[forge → join]', 'Joining a per-project channel...')
const joinResult = await mcpCall('forge', 'join', { channel: '#irc-research' })
console.log(`  ${C.green}✓${C.reset} ${joinResult}`)
await sleep(500)

console.log('')
log('[forge → topic]', 'Broadcasting task status via channel topic...')
const topicResult = await mcpCall('forge', 'topic', {
  channel: '#general',
  text: 'status: irctokens research done | rec: irctokens | next: integration',
})
console.log(`  ${C.green}✓${C.reset} ${topicResult}`)
await sleep(500)

console.log('')
log('[bandit → status]', 'Checking connection health...')
const statusResult = await mcpCall('bandit', 'status', {})
console.log(`  ${C.green}✓${C.reset} ${statusResult}`)

console.log('')
console.log(`${C.cyan}=== Demo complete ===${C.reset}`)
console.log('')
console.log('In production with Claude Code:')
console.log('  HIGH priority (mentions, DMs, #gate) → Claude acts on them immediately')
console.log('  NORMAL (other channels) → throttled summaries, Claude reads when convenient')
console.log('  fetch_history → Claude catches up on missed messages')
console.log('  join/part → dynamic channel subscription per task')
console.log('  topic → shared state / status board for all agents in a channel')
console.log('')
