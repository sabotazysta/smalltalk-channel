#!/usr/bin/env bun
/**
 * smalltalk-channel — IRC bridge for Claude Code.
 *
 * MCP server exposing IRC as a Claude channel. Supports multiple simultaneous
 * IRC server connections via ConnectionPool.
 *
 * Notification tiers:
 *   TIER 1 (high)   — mentions, DMs, #urgent messages — emit immediately
 *   TIER 2 (normal) — other channel messages — throttled, max 1 per 30s per channel
 *   TIER 3 (silent) — join/part/quit/mode/own messages — never notify
 *
 * Config lives in ~/.claude/channels/smalltalk/.env or environment variables.
 * Env vars configure the default (primary) server. Additional servers can be
 * added at runtime via the connect tool.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { ConnectionPool, type Connection } from './connection-pool.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATE_DIR = join(homedir(), '.claude', 'channels', 'smalltalk')
const ENV_FILE = join(STATE_DIR, '.env')

try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
  }
} catch {}

const REGISTRY_URL       = process.env.REGISTRY_URL       ?? 'https://smalltalk.chat/api/registry'
const REGISTRY_SERVER_ID = process.env.REGISTRY_SERVER_ID  // e.g. "smalltalk-public"

const IRC_HOST     = process.env.IRC_HOST
const IRC_PORT     = parseInt(process.env.IRC_PORT ?? '6667', 10)
const IRC_NICK     = process.env.IRC_NICK
const IRC_USERNAME = process.env.IRC_USERNAME
const IRC_PASSWORD = process.env.IRC_PASSWORD
const IRC_TLS      = (process.env.IRC_TLS      ?? 'false').toLowerCase() === 'true'
const IRC_WEBSOCKET= (process.env.IRC_WEBSOCKET ?? 'false').toLowerCase() === 'true'
const IRC_CHANNELS_RAW = process.env.IRC_CHANNELS ?? '#general'
const IRC_CHANNELS: string[] = IRC_CHANNELS_RAW.split(',').map((c: string) => c.trim()).filter(Boolean)
const GATE_CHANNEL = (process.env.IRC_GATE_CHANNEL ?? '#urgent').toLowerCase()
const IRC_SKILLS   = process.env.IRC_SKILLS?.trim() || undefined

const missing: string[] = []
if (!IRC_HOST)     missing.push('IRC_HOST')
if (!IRC_NICK)     missing.push('IRC_NICK')
if (!IRC_USERNAME) missing.push('IRC_USERNAME')
if (!IRC_PASSWORD) missing.push('IRC_PASSWORD')

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

const THROTTLE_WINDOW_MS = 30_000

type ThrottleEntry = {
  lastNotified: number
  buffered: number
  lastNick: string
  lastText: string
  bufferTimeout: ReturnType<typeof setTimeout> | null
}

type PendingNames = {
  users: string[]
  resolve: (users: string[]) => void
  timer: ReturnType<typeof setTimeout>
}

type HistoryMessage = { ts: string; nick: string; text: string }
type PendingHistory = {
  batchId: string | null
  messages: HistoryMessage[]
  resolve: (msgs: HistoryMessage[]) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type PendingTopic = {
  resolve: (topic: string) => void
  timer: ReturnType<typeof setTimeout>
}

type ConnState = {
  joinedChannels: Set<string>
  channelUsers: Map<string, Set<string>>
  pendingNames: Map<string, PendingNames>
  pendingHistory: Map<string, PendingHistory>
  batchIdToChannel: Map<string, string>
  pendingTopics: Map<string, PendingTopic>
  channelThrottle: Map<string, ThrottleEntry>
}

const connStates = new Map<string, ConnState>()

// Total live messages received across all connections (excludes own + chathistory replays)
let totalMessagesReceived = 0

function normalizeHost(host: string): string {
  return host.replace(/^wss?:\/\//i, '').replace(/^ircs?:\/\//i, '').toLowerCase()
}

// Connection state key: host:port — prevents collisions when two servers share the same IP
function connKey(host: string, port: number): string {
  return normalizeHost(host) + ':' + port
}

function getState(host: string, port: number): ConnState {
  const key = connKey(host, port)
  let s = connStates.get(key)
  if (!s) {
    s = {
      joinedChannels: new Set(),
      channelUsers: new Map(),
      pendingNames: new Map(),
      pendingHistory: new Map(),
      batchIdToChannel: new Map(),
      pendingTopics: new Map(),
      channelThrottle: new Map(),
    }
    connStates.set(key, s)
  }
  return s
}

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

const pool = new ConnectionPool()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEventTs(time: Date | string | null | undefined): string {
  if (!time) return new Date().toISOString()
  if (time instanceof Date) return time.toISOString()
  if (typeof time === 'string') return time
  return new Date().toISOString()
}

function isMention(text: string, nick: string): boolean {
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s|@)${escaped}(?:\\s|[,:!?]|$)`, 'i').test(text)
}

function serverPrefix(conn: Connection): string {
  if (pool.size() <= 1) return ''
  // Include port if multiple connections share the same host (e.g. hanza:8080 vs clinic:8082)
  const sameHost = pool.getAll().filter(c => normalizeHost(c.config.host) === normalizeHost(conn.config.host))
  const label = sameHost.length > 1
    ? `${normalizeHost(conn.config.host)}:${conn.config.port}`
    : normalizeHost(conn.config.host)
  return `[${label}] `
}

// ---------------------------------------------------------------------------
// MCP notification emitters
// ---------------------------------------------------------------------------

function emitHighPriority(opts: {
  content: string
  channel: string
  nick: string
  ts: string
  mention: boolean
  source?: string
}) {
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: opts.content,
      meta: {
        channel: opts.channel,
        nick: opts.nick,
        ts: opts.ts,
        priority: 'high',
        mention: opts.mention ? 'true' : 'false',
        ...(opts.source ? { source: opts.source } : {}),
      },
    },
  })
}

function emitThrottledSummary(channel: string, entry: ThrottleEntry, source?: string) {
  const count = entry.buffered
  const preview = entry.lastText.length > 60
    ? entry.lastText.slice(0, 57) + '...'
    : entry.lastText

  const content = count === 1
    ? `[${channel}] <${entry.lastNick}> ${entry.lastText}`
    : `[${count} messages in ${channel} — last: "<${entry.lastNick}> ${preview}"] Use fetch_history to read all.`

  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: {
        channel,
        nick: entry.lastNick,
        ts: new Date().toISOString(),
        priority: 'normal',
        mention: 'false',
        ...(source ? { source } : {}),
      },
    },
  })

  entry.lastNotified = Date.now()
  entry.buffered = 0
  entry.bufferTimeout = null
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

function handleMessage(conn: Connection, event: {
  target: string
  nick: string
  message: string
  time: Date | string | null
  batch?: { id: string; type: string; params: string[] }
}) {
  const st = getState(conn.config.host, conn.config.port)
  const gateChannel = (conn.config.gateChannel ?? '#urgent').toLowerCase()
  const myNick = conn.config.nick

  // CHATHISTORY batch collection
  if (event.batch?.type === 'chathistory') {
    const batchChannel = st.batchIdToChannel.get(event.batch.id)
    if (batchChannel) {
      const pending = st.pendingHistory.get(batchChannel)
      if (pending) {
        pending.messages.push({ ts: getEventTs(event.time), nick: event.nick, text: event.message })
      }
      return
    }
  }

  // Count live messages (excludes chathistory replays; includes own for accurate totals)
  if (event.nick !== conn.config.nick) totalMessagesReceived++

  const ts = getEventTs(event.time)
  const targetLower = event.target.toLowerCase()
  const isChannelMsg = event.target.startsWith('#') || event.target.startsWith('&')
  const isDM = !isChannelMsg
  const prefix = serverPrefix(conn)
  const source = normalizeHost(conn.config.host)

  // TIER 3: Own messages
  if (event.nick === myNick) return

  // TIER 1: Direct messages
  if (isDM) {
    emitHighPriority({
      content: `${prefix}[DM from ${event.nick}]: ${event.message}`,
      channel: 'dm',
      nick: event.nick,
      ts,
      mention: false,
      source,
    })
    return
  }

  // Only forward from joined channels
  if (!st.joinedChannels.has(targetLower)) return

  const channel = event.target

  // TIER 1: #urgent
  if (targetLower === gateChannel) {
    emitHighPriority({
      content: `${prefix}[${channel}] <${event.nick}> ${event.message}`,
      channel,
      nick: event.nick,
      ts,
      mention: false,
      source,
    })
    return
  }

  // TIER 1: Mentions
  if (isMention(event.message, myNick)) {
    emitHighPriority({
      content: `${prefix}[MENTION] <${event.nick}> in ${channel}: ${event.message}`,
      channel,
      nick: event.nick,
      ts,
      mention: true,
      source,
    })
    return
  }

  // TIER 2: Throttled normal messages
  const now = Date.now()
  let entry = st.channelThrottle.get(targetLower)
  if (!entry) {
    entry = { lastNotified: 0, buffered: 0, lastNick: event.nick, lastText: event.message, bufferTimeout: null }
    st.channelThrottle.set(targetLower, entry)
  }

  entry.buffered += 1
  entry.lastNick = event.nick
  entry.lastText = event.message

  const timeSinceLast = now - entry.lastNotified
  if (timeSinceLast >= THROTTLE_WINDOW_MS) {
    if (entry.bufferTimeout) { clearTimeout(entry.bufferTimeout); entry.bufferTimeout = null }
    emitThrottledSummary(targetLower, entry, source)
  } else if (!entry.bufferTimeout) {
    const delay = THROTTLE_WINDOW_MS - timeSinceLast
    entry.bufferTimeout = setTimeout(() => {
      const e = st.channelThrottle.get(targetLower)
      if (e && e.buffered > 0) emitThrottledSummary(targetLower, e, source)
    }, delay)
  }
}

// ---------------------------------------------------------------------------
// Wire pool callbacks
// ---------------------------------------------------------------------------

pool.onRegistered = (conn) => {
  process.stderr.write(`smalltalk: connected as ${conn.config.nick} on ${conn.config.host}:${conn.config.port}\n`)
  // On reconnect, rejoin both config channels and any runtime-joined channels
  const st = getState(conn.config.host, conn.config.port)
  const channelsToJoin = new Set([
    ...(conn.config.channels ?? ['#general']),
    ...st.joinedChannels, // rejoin runtime channels after reconnect
  ])
  for (const ch of channelsToJoin) {
    conn.client.join(ch)
  }
}

pool.onMessage = (conn, event) => handleMessage(conn, event)

pool.onJoin = (conn, event) => {
  if (event.nick === conn.config.nick) {
    const st = getState(conn.config.host, conn.config.port)
    st.joinedChannels.add(event.channel.toLowerCase())
    process.stderr.write(`smalltalk: [${normalizeHost(conn.config.host)}] joined ${event.channel}\n`)
    // Send !register to #general on session start if skills are configured
    if (conn.config.skills && event.channel.toLowerCase() === '#general') {
      conn.client.say('#general', `!register ${conn.config.skills}`)
      process.stderr.write(`smalltalk: [${normalizeHost(conn.config.host)}] sent !register with skills: ${conn.config.skills}\n`)
    }
  }
}

pool.onPart = (conn, event) => {
  if (event.nick === conn.config.nick) {
    getState(conn.config.host, conn.config.port).joinedChannels.delete(event.channel.toLowerCase())
  }
}

pool.onKick = (conn, event) => {
  if (event.kicked === conn.config.nick) {
    getState(conn.config.host, conn.config.port).joinedChannels.delete(event.channel.toLowerCase())
  }
}

pool.onUserlist = (conn, event) => {
  const st = getState(conn.config.host, conn.config.port)
  const ch = event.channel.toLowerCase()
  st.channelUsers.set(ch, new Set(event.users.map((u) => u.nick)))
  const pending = st.pendingNames.get(ch)
  if (pending) {
    clearTimeout(pending.timer)
    st.pendingNames.delete(ch)
    pending.resolve(event.users.map((u) => u.nick))
  }
}

pool.onTopic = (conn, event) => {
  const st = getState(conn.config.host, conn.config.port)
  const ch = event.channel.toLowerCase()
  const pending = st.pendingTopics.get(ch)
  if (pending) {
    clearTimeout(pending.timer)
    st.pendingTopics.delete(ch)
    pending.resolve(event.topic)
  }
}

pool.onBatchStartChathistory = (conn, event) => {
  const st = getState(conn.config.host, conn.config.port)
  const channel = (event.params[0] ?? '').toLowerCase()
  const pending = st.pendingHistory.get(channel)
  if (pending) {
    pending.batchId = event.id
    st.batchIdToChannel.set(event.id, channel)
  }
}

pool.onBatchEndChathistory = (conn, event) => {
  const st = getState(conn.config.host, conn.config.port)
  const channel = st.batchIdToChannel.get(event.id)
  st.batchIdToChannel.delete(event.id)
  if (!channel) return
  const pending = st.pendingHistory.get(channel)
  if (!pending) return
  clearTimeout(pending.timer)
  st.pendingHistory.delete(channel)
  pending.resolve(pending.messages)
}

pool.onClose = (conn) => {
  process.stderr.write(`smalltalk: [${normalizeHost(conn.config.host)}] connection closed\n`)
  // Don't clear joinedChannels — they're needed for rejoin after auto-reconnect
  // Status is already set to 'disconnected' by the connection pool
}

pool.onSocketClose = (conn) => {
  // Don't clear joinedChannels — needed for rejoin on reconnect
}

pool.onReconnecting = (conn, event) => {
  process.stderr.write(
    `smalltalk: [${normalizeHost(conn.config.host)}] reconnecting (attempt ${event.attempt}, wait ${Math.round(event.wait / 1000)}s)\n`
  )
}

// ---------------------------------------------------------------------------
// Auto-connect from env vars
// ---------------------------------------------------------------------------

if (missing.length === 0) {
  pool.connect({
    host: IRC_HOST!,
    port: IRC_PORT,
    nick: IRC_NICK!,
    username: IRC_USERNAME!,
    password: IRC_PASSWORD!,
    tls: IRC_TLS,
    websocket: IRC_WEBSOCKET,
    channels: IRC_CHANNELS,
    gateChannel: GATE_CHANNEL,
    skills: IRC_SKILLS,
  }).catch((err: Error) => {
    process.stderr.write(`smalltalk: auto-connect failed: ${err.message}\n`)
  })
} else {
  process.stderr.write(
    `smalltalk: no default server configured (missing: ${missing.join(', ')})\n` +
    `  set in ${ENV_FILE} or use the connect tool to add servers at runtime\n`
  )
}

// ---------------------------------------------------------------------------
// Registry heartbeat
// ---------------------------------------------------------------------------

async function postHeartbeat(): Promise<void> {
  if (!REGISTRY_SERVER_ID) return

  const primary = pool.getPrimary()
  const memberCount = primary
    ? (() => {
        const st = getState(primary.config.host, primary.config.port)
        const seen = new Set<string>()
        for (const users of st.channelUsers.values()) {
          for (const u of users) seen.add(u)
        }
        return seen.size
      })()
    : 0

  try {
    const res = await fetch(`${REGISTRY_URL}/${REGISTRY_SERVER_ID}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_count: memberCount, message_count: totalMessagesReceived }),
    })
    if (!res.ok) {
      process.stderr.write(`smalltalk: heartbeat failed: ${res.status} ${res.statusText}\n`)
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`smalltalk: heartbeat error: ${msg}\n`)
  }
}

if (REGISTRY_SERVER_ID) {
  // First heartbeat 30s after start (let connection stabilise)
  setTimeout(() => { void postHeartbeat() }, 30_000)
  // Then every 10 minutes
  setInterval(() => { void postHeartbeat() }, 10 * 60 * 1000)
  process.stderr.write(`smalltalk: heartbeat enabled for registry server "${REGISTRY_SERVER_ID}"\n`)
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'smalltalk', version: '0.3.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'You are connected to an IRC server via the smalltalk channel plugin.',
      '',
      'NOTIFICATION TIERS — messages arrive at different priority levels:',
      '',
      '  HIGH PRIORITY (priority: "high") — act on these:',
      '    - [MENTION] <nick> in #channel: ... — someone mentioned you directly',
      '    - [DM from nick]: ... — a private message sent directly to you',
      '    - [#urgent] <nick> ... — a message in the coordination channel (#urgent)',
      '    These arrive in full. Address them when you see them.',
      '',
      '  NORMAL (priority: "normal") — informational summaries:',
      '    - "[N messages in #channel — last: ...]" or a single message preview',
      '    These are throttled: at most 1 notification per channel per 30 seconds.',
      '    The full conversation is NOT included — use fetch_history to read it.',
      '    Do not interrupt deep work for these — batch-read when convenient.',
      '',
      '  SILENT — join/part/quit/mode events are never surfaced as notifications.',
      '',
      'TOOLS:',
      '',
      '  send — post a message to a channel. Pass channel (e.g. "#general") and text.',
      '',
      '  dm — send a private message directly to another agent or user by nick.',
      '',
      '  who — list users currently in a channel. Useful to see which agents are online.',
      '',
      '  fetch_history — retrieve recent messages from a channel (IRCv3 CHATHISTORY).',
      '    Use this whenever you see a normal-priority summary and want the full context.',
      '    The IRC server must support the chathistory capability.',
      '    Returns messages in chronological order.',
      '',
      '  list_channels — list the IRC channels you are currently joined to.',
      '',
      '  status — check connection health. Useful to verify connectivity before important tasks.',
      '',
      '  join — join an additional IRC channel at runtime.',
      '',
      '  part — leave an IRC channel. Useful when a task-specific channel is no longer needed.',
      '',
      '  topic — get or set a channel topic. Topics persist and are visible to all members.',
      '    Use to broadcast current task status: topic #project "working on: auth | done: api"',
      '',
      '  connect — connect to an additional IRC server at runtime.',
      '',
      '  disconnect — disconnect from an IRC server.',
      '',
      'MULTI-SERVER:',
      '  When connected to multiple servers, pass server="irc.example.com" to any tool',
      '  to target a specific server. Omit server to use the primary (first connected) server.',
      '  Notifications include a server prefix when multiple servers are active.',
      '',
      'WORKFLOW GUIDANCE:',
      '',
      '  - High-priority notifications (mentions, DMs, #urgent) interrupt your current task.',
      '  - Normal channel summaries are background signal — read them when you have a break.',
      '  - When you do check a channel, use fetch_history rather than waiting for live msgs.',
      '  - IRC is a multi-user environment — always check the nick so you know who is talking.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send',
      description: 'Send a message to an IRC channel.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'IRC channel to send to, e.g. "#general"' },
          text: { type: 'string', description: 'Message text to send' },
          server: { type: 'string', description: 'IRC server host, e.g. "irc.smalltalk.chat". Defaults to primary connection.' },
        },
        required: ['channel', 'text'],
      },
    },
    {
      name: 'dm',
      description: 'Send a private message directly to another IRC user (agent or human).',
      inputSchema: {
        type: 'object',
        properties: {
          nick: { type: 'string', description: 'Recipient nick, e.g. "scout"' },
          text: { type: 'string', description: 'Message text' },
          server: { type: 'string', description: 'IRC server host. Defaults to primary.' },
        },
        required: ['nick', 'text'],
      },
    },
    {
      name: 'who',
      description: 'List users currently in an IRC channel.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'IRC channel to list users in, e.g. "#general"' },
          server: { type: 'string', description: 'IRC server host. Defaults to primary.' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'fetch_history',
      description:
        'Fetch recent messages from an IRC channel using IRCv3 CHATHISTORY. ' +
        'Requires the IRC server to support the chathistory capability. ' +
        'Returns messages in chronological order.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'IRC channel to fetch history for, e.g. "#general"' },
          limit: { type: 'number', description: 'Number of messages to fetch (default: 50, max: 100)' },
          server: { type: 'string', description: 'IRC server host. Defaults to primary.' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'list_channels',
      description: 'List IRC channels you are currently joined to.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'IRC server host. Omit to list all channels across all servers.' },
        },
        required: [],
      },
    },
    {
      name: 'status',
      description: 'Check the IRC connection status — connected servers, uptime, and channels.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'join',
      description: 'Join an additional IRC channel. Useful to subscribe to project-specific channels at runtime.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel to join, e.g. "#project-x"' },
          key: { type: 'string', description: 'Channel key (password) if the channel is +k protected.' },
          server: { type: 'string', description: 'IRC server host. Defaults to primary.' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'part',
      description: 'Leave an IRC channel. Useful to unsubscribe from channels you no longer need.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel to leave, e.g. "#project-x"' },
          server: { type: 'string', description: 'IRC server host. Defaults to primary.' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'topic',
      description:
        'Get or set the topic of an IRC channel. ' +
        'Topics act as shared state — useful for broadcasting task status, ' +
        'current work, or coordination notes to all agents in the channel.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'IRC channel, e.g. "#project-x"' },
          text: { type: 'string', description: 'New topic to set. Omit to get the current topic.' },
          server: { type: 'string', description: 'IRC server host. Defaults to primary.' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'connect',
      description: 'Connect to an additional IRC server. After connecting, use the server parameter on other tools to target it.',
      inputSchema: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'IRC server host, e.g. "irc.example.com"' },
          port: { type: 'number', description: 'IRC port (default: 6667, or 6697 for TLS)' },
          nick: { type: 'string', description: 'Nickname for this connection' },
          username: { type: 'string', description: 'Username/account name (defaults to nick)' },
          password: { type: 'string', description: 'Account password' },
          tls: { type: 'boolean', description: 'Use TLS (default: false)' },
          websocket: { type: 'boolean', description: 'Use WebSocket transport (default: false)' },
          channels: { type: 'string', description: 'Comma-separated channels to join (default: #general)' },
          gate_channel: { type: 'string', description: 'High-priority gate channel (default: #urgent)' },
        },
        required: ['host', 'nick', 'password'],
      },
    },
    {
      name: 'disconnect',
      description: 'Disconnect from an IRC server.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'IRC server host to disconnect from' },
        },
        required: ['server'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (req.params.name) {

      case 'send': {
        const channel = args.channel as string
        const text = args.text as string
        if (!channel || !text) throw new Error('channel and text are required')
        const conn = pool.resolve(args.server as string | undefined)
        conn.client.say(channel, text)
        return { content: [{ type: 'text', text: `sent to ${channel}` }] }
      }

      case 'dm': {
        const nick = args.nick as string
        const text = args.text as string
        if (!nick || !text) throw new Error('nick and text are required')
        const conn = pool.resolve(args.server as string | undefined)
        conn.client.say(nick, text)
        return { content: [{ type: 'text', text: `DM sent to ${nick}` }] }
      }

      case 'who': {
        const channel = (args.channel as string).toLowerCase()
        if (!channel) throw new Error('channel is required')
        const conn = pool.resolve(args.server as string | undefined)
        const st = getState(conn.config.host, conn.config.port)

        const users = await new Promise<string[]>((resolve, reject) => {
          const timer = setTimeout(() => {
            st.pendingNames.delete(channel)
            reject(new Error('NAMES request timed out'))
          }, 5_000)
          st.pendingNames.set(channel, { users: [], resolve, timer })
          conn.client.raw(`NAMES ${channel}`)
        })

        if (users.length === 0) {
          return { content: [{ type: 'text', text: `no users in ${channel} (or not joined)` }] }
        }
        return { content: [{ type: 'text', text: `users in ${channel} (${users.length}): ${users.join(', ')}` }] }
      }

      case 'fetch_history': {
        const channel = (args.channel as string).toLowerCase()
        const limit = Math.min(Math.max(1, (args.limit as number | undefined) ?? 50), 100)
        if (!channel) throw new Error('channel is required')
        const conn = pool.resolve(args.server as string | undefined)
        const st = getState(conn.config.host, conn.config.port)

        const existing = st.pendingHistory.get(channel)
        if (existing) {
          clearTimeout(existing.timer)
          existing.reject(new Error('superseded by new fetch_history request'))
          st.pendingHistory.delete(channel)
        }

        const messages = await new Promise<HistoryMessage[]>((resolve, reject) => {
          const timer = setTimeout(() => {
            st.pendingHistory.delete(channel)
            reject(new Error('CHATHISTORY request timed out — server may not support the chathistory capability'))
          }, 10_000)
          st.pendingHistory.set(channel, { batchId: null, messages: [], resolve, reject, timer })
          conn.client.raw(`CHATHISTORY LATEST ${channel} * ${limit}`)
        })

        if (messages.length === 0) {
          return { content: [{ type: 'text', text: `no history available for ${channel}` }] }
        }

        const formatted = messages.map((m: HistoryMessage) => `[${m.ts}] <${m.nick}> ${m.text}`).join('\n')
        return { content: [{ type: 'text', text: `${messages.length} message(s) from ${channel}:\n\n${formatted}` }] }
      }

      case 'join': {
        const channel = args.channel as string
        if (!channel || !channel.startsWith('#')) throw new Error('channel is required and must start with #')
        const conn = pool.resolve(args.server as string | undefined)
        const st = getState(conn.config.host, conn.config.port)

        if (st.joinedChannels.has(channel.toLowerCase())) {
          return { content: [{ type: 'text', text: `already in ${channel}` }] }
        }
        const key = args.key as string | undefined
        conn.client.join(channel, key)
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 3_000)
          const check = setInterval(() => {
            if (st.joinedChannels.has(channel.toLowerCase())) {
              clearInterval(check); clearTimeout(timeout); resolve()
            }
          }, 100)
        })
        return {
          content: [{
            type: 'text',
            text: st.joinedChannels.has(channel.toLowerCase())
              ? `joined ${channel}`
              : `join sent to ${channel} — may need permissions`,
          }],
        }
      }

      case 'part': {
        const channel = args.channel as string
        if (!channel || !channel.startsWith('#')) throw new Error('channel is required and must start with #')
        const conn = pool.resolve(args.server as string | undefined)
        const st = getState(conn.config.host, conn.config.port)
        if (!st.joinedChannels.has(channel.toLowerCase())) {
          return { content: [{ type: 'text', text: `not in ${channel}` }] }
        }
        conn.client.part(channel)
        return { content: [{ type: 'text', text: `left ${channel}` }] }
      }

      case 'topic': {
        const channel = args.channel as string
        if (!channel || !channel.startsWith('#')) throw new Error('channel is required and must start with #')
        const conn = pool.resolve(args.server as string | undefined)
        const st = getState(conn.config.host, conn.config.port)
        const newTopic = args.text as string | undefined

        if (newTopic !== undefined) {
          conn.client.setTopic(channel, newTopic)
          return { content: [{ type: 'text', text: `topic set in ${channel}` }] }
        }

        const chLower = channel.toLowerCase()
        const topic = await new Promise<string>((resolve) => {
          const timer = setTimeout(() => {
            st.pendingTopics.delete(chLower)
            resolve('(no topic set)')
          }, 5_000)
          st.pendingTopics.set(chLower, { resolve, timer })
          conn.client.raw(`TOPIC ${channel}`)
        })
        return { content: [{ type: 'text', text: `topic in ${channel}: ${topic === '' ? '(no topic set)' : topic}` }] }
      }

      case 'list_channels': {
        const serverFilter = args.server as string | undefined
        const allConns = serverFilter
          ? [pool.resolve(serverFilter)]
          : pool.getAll()

        if (allConns.length === 0) {
          return { content: [{ type: 'text', text: 'not connected to any servers' }] }
        }

        if (allConns.length === 1) {
          const st = getState(allConns[0].config.host, allConns[0].config.port)
          const channels = Array.from(st.joinedChannels)
          if (channels.length === 0) return { content: [{ type: 'text', text: 'not currently joined to any channels' }] }
          return { content: [{ type: 'text', text: `joined channels (${channels.length}): ${channels.join(', ')}` }] }
        }

        const lines: string[] = ['joined channels:']
        for (const conn of allConns) {
          const st = getState(conn.config.host, conn.config.port)
          const channels = Array.from(st.joinedChannels)
          lines.push(`  ${normalizeHost(conn.config.host)}: ${channels.join(', ') || '(none)'}`)
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'status': {
        const all = pool.getAll()
        if (all.length === 0) {
          return { content: [{ type: 'text', text: 'not connected to any IRC servers' }] }
        }

        const primary = pool.getPrimary()
        const lines: string[] = all.length > 1 ? [`connected to ${all.length} servers:`] : []

        for (const conn of all) {
          const st = getState(conn.config.host, conn.config.port)
          const uptimeMs = conn.connectedAt ? Date.now() - conn.connectedAt.getTime() : 0
          const uptimeSec = Math.floor(uptimeMs / 1000)
          const uptimeStr = uptimeSec < 60
            ? `${uptimeSec}s`
            : uptimeSec < 3600
            ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
            : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`
          const channels = Array.from(st.joinedChannels)
          const isPrimary = conn === primary

          if (all.length === 1) {
            lines.push(`connected to ${conn.config.host}:${conn.config.port} as ${conn.config.nick} (uptime: ${uptimeStr}, channels: ${channels.join(', ') || 'none'})`)
          } else {
            lines.push(`  ${isPrimary ? '[primary] ' : ''}${conn.config.host}:${conn.config.port} as ${conn.config.nick} — uptime ${uptimeStr}, channels: ${channels.join(', ') || 'none'}`)
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'connect': {
        const host = args.host as string
        const nick = args.nick as string
        const password = args.password as string
        if (!host || !nick || !password) throw new Error('host, nick, and password are required')

        const port = (args.port as number | undefined) ?? 6667
        const tls = (args.tls as boolean | undefined) ?? false
        const websocket = (args.websocket as boolean | undefined) ?? false
        const channelsRaw = (args.channels as string | undefined) ?? '#general'
        const channels = channelsRaw.split(',').map(c => c.trim()).filter(Boolean)
        const gateChannel = (args.gate_channel as string | undefined) ?? '#urgent'

        await pool.connect({
          host,
          port,
          nick,
          username: (args.username as string | undefined) ?? nick,
          password,
          tls,
          websocket,
          channels,
          gateChannel,
        })

        return { content: [{ type: 'text', text: `connecting to ${host}:${port} as ${nick} — use status to confirm when ready` }] }
      }

      case 'disconnect': {
        const server = args.server as string
        if (!server) throw new Error('server is required')
        // Resolve conn before disconnecting to get the correct host:port key for connStates
        let stateKey: string
        try {
          const c = pool.resolve(server)
          stateKey = connKey(c.config.host, c.config.port)
        } catch {
          stateKey = normalizeHost(server)
        }
        await pool.disconnect(server)
        connStates.delete(stateKey)
        return { content: [{ type: 'text', text: `disconnected from ${server}` }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    }
  }
})

// ---------------------------------------------------------------------------
// Transport + shutdown
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport()
await mcp.connect(transport)

function shutdown(signal: string) {
  process.stderr.write(`smalltalk channel: received ${signal}, disconnecting...\n`)
  for (const conn of pool.getAll()) {
    try { conn.client.quit('Claude Code shutting down') } catch {}
  }
  setTimeout(() => process.exit(0), 500)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

process.on('uncaughtException', (err: Error) => {
  process.stderr.write(`smalltalk channel: uncaught error: ${err.message}\n`)
})
