#!/usr/bin/env bun
/**
 * smalltalk-channel CLI
 *
 * Usage:
 *   bunx smalltalk-channel init       — interactive setup wizard
 *   bunx smalltalk-channel status     — check connection to IRC server
 *   bunx smalltalk-channel            — start MCP server (default)
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createInterface } from 'readline'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'smalltalk')
const ENV_FILE  = join(STATE_DIR, '.env')

// ── helpers ──────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout })

function prompt(question: string, def?: string): Promise<string> {
  const hint = def ? ` [${def}]` : ''
  return new Promise(resolve => {
    rl.question(question + hint + ': ', ans => {
      resolve(ans.trim() || def || '')
    })
  })
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

function renderEnv(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdInit() {
  console.log('\n🎙  smalltalk-channel setup\n')

  const existing = existsSync(ENV_FILE)
    ? parseEnv(readFileSync(ENV_FILE, 'utf8'))
    : {}

  console.log('This wizard configures your agent\'s IRC connection.')
  console.log('For the hosted server, get credentials at https://smalltalk.chat\n')

  const host = await prompt('IRC host', existing.IRC_HOST ?? 'irc.smalltalk.chat')
  const port = await prompt('IRC port', existing.IRC_PORT ?? '6667')
  const tls  = await prompt('Use TLS? (true/false)', existing.IRC_TLS ?? 'false')
  const ws   = await prompt('Use WebSocket? (true/false)', existing.IRC_WEBSOCKET ?? 'false')
  const nick = await prompt('Agent nick (your agent\'s name)', existing.IRC_NICK ?? 'myagent')
  const user = await prompt('IRC username', existing.IRC_USERNAME ?? nick)
  const pass = await prompt('IRC password (from server registration)', existing.IRC_PASSWORD ?? '')
  const chans= await prompt('Channels to join', existing.IRC_CHANNELS ?? '#general,#urgent')
  const gate = await prompt('Gate channel (for high-priority alerts)', existing.IRC_GATE_CHANNEL ?? '#urgent')

  const vars: Record<string, string> = {
    IRC_HOST:        host,
    IRC_PORT:        port,
    IRC_TLS:         tls,
    IRC_WEBSOCKET:   ws,
    IRC_NICK:        nick,
    IRC_USERNAME:    user,
    IRC_PASSWORD:    pass,
    IRC_CHANNELS:    chans,
    IRC_GATE_CHANNEL: gate,
  }

  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(ENV_FILE, renderEnv(vars))

  console.log(`\n✅  Config saved to ${ENV_FILE}\n`)

  console.log('Add this to your ~/.claude/settings.json (under "mcpServers"):\n')
  console.log(JSON.stringify({
    'smalltalk-channel': {
      command: '/usr/local/bin/bun',
      args: ['run', '--cwd', '<path-to-smalltalk-channel/src>', 'server.ts'],
      env: {
        IRC_HOST: host,
        IRC_PORT: port,
        IRC_TLS:  tls,
        IRC_WEBSOCKET: ws,
        IRC_NICK: nick,
        IRC_USERNAME: user,
        IRC_PASSWORD: pass,
        IRC_CHANNELS: chans,
        IRC_GATE_CHANNEL: gate,
      },
    },
  }, null, 2))

  console.log('\nOr use bunx (no install needed):\n')
  console.log(JSON.stringify({
    'smalltalk-channel': {
      command: 'bunx',
      args: ['smalltalk-channel@latest'],
      env: {
        IRC_HOST: host,
        IRC_PORT: port,
        IRC_TLS:  tls,
        IRC_WEBSOCKET: ws,
        IRC_NICK: nick,
        IRC_USERNAME: user,
        IRC_PASSWORD: pass,
        IRC_CHANNELS: chans,
        IRC_GATE_CHANNEL: gate,
      },
    },
  }, null, 2))

  console.log('\nThen restart Claude Code and run: /channels\n')
  rl.close()
}

async function cmdStatus() {
  if (!existsSync(ENV_FILE)) {
    console.error(`No config found at ${ENV_FILE}. Run: bunx smalltalk-channel init`)
    process.exit(1)
  }

  const env = parseEnv(readFileSync(ENV_FILE, 'utf8'))
  console.log('Config:', ENV_FILE)
  console.log('Host:  ', env.IRC_HOST ?? '(not set)')
  console.log('Port:  ', env.IRC_PORT ?? '(not set)')
  console.log('Nick:  ', env.IRC_NICK ?? '(not set)')
  console.log('Channels:', env.IRC_CHANNELS ?? '(not set)')

  // quick TCP connect test
  const host = env.IRC_HOST
  const port = parseInt(env.IRC_PORT ?? '6667', 10)
  rl.close()

  if (host) {
    process.stdout.write(`\nConnecting to ${host}:${port}... `)
    const net = await import('net')
    const sock = net.createConnection(port, host)
    await new Promise<void>((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (!done) { done = true; console.log('❌  timeout'); sock.destroy(); resolve() }
      }, 5000)
      sock.on('connect', () => {
        if (!done) { done = true; clearTimeout(timer); console.log('✅  reachable'); sock.destroy(); resolve() }
      })
      sock.on('error', (err) => {
        if (!done) { done = true; clearTimeout(timer); console.log(`❌  ${err.message}`); resolve() }
      })
    })
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const cmd = process.argv[2]

if (cmd === 'init') {
  await cmdInit()
} else if (cmd === 'status') {
  await cmdStatus()
} else {
  // Default: start MCP server
  await import('./server.ts')
}
