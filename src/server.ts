#!/usr/bin/env bun
/**
 * smalltalk-channel — IRC bridge for Claude Code.
 *
 * MCP server exposing IRC as a Claude channel. Connects to an IRC server via
 * irc-framework, joins configured channels, and bridges inbound messages as
 * MCP notifications with smart priority tiers:
 *
 *   TIER 1 (high)   — mentions, DMs, #gate messages — emit immediately
 *   TIER 2 (normal) — other channel messages — throttled, max 1 per 30s per channel
 *   TIER 3 (silent) — join/part/quit/mode/own messages — buffer only, never notify
 *
 * Config lives in ~/.claude/channels/smalltalk/.env or environment variables.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import IRC from 'irc-framework'
import { readFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATE_DIR = join(homedir(), '.claude', 'channels', 'smalltalk')
const ENV_FILE = join(STATE_DIR, '.env')

// Load ~/.claude/channels/smalltalk/.env — real env wins.
// Plugin-spawned servers don't inherit an env block, so the .env is essential.
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
  }
} catch {}

const IRC_HOST = process.env.IRC_HOST ?? '127.0.0.1'
const IRC_PORT = parseInt(process.env.IRC_PORT ?? '6667', 10)
const IRC_NICK = process.env.IRC_NICK
const IRC_USERNAME = process.env.IRC_USERNAME
const IRC_PASSWORD = process.env.IRC_PASSWORD
const IRC_TLS = (process.env.IRC_TLS ?? 'false').toLowerCase() === 'true'
const IRC_CHANNELS_RAW = process.env.IRC_CHANNELS ?? '#general'
const IRC_CHANNELS: string[] = IRC_CHANNELS_RAW.split(',').map((c: string) => c.trim()).filter(Boolean)
const GATE_CHANNEL = (process.env.IRC_GATE_CHANNEL ?? '#gate').toLowerCase()

// Validate required vars
const missing: string[] = []
if (!IRC_NICK) missing.push('IRC_NICK')
if (!IRC_USERNAME) missing.push('IRC_USERNAME')
if (!IRC_PASSWORD) missing.push('IRC_PASSWORD')

if (missing.length > 0) {
  process.stderr.write(
    `smalltalk channel: missing required config: ${missing.join(', ')}\n` +
    `  set in ${ENV_FILE}\n` +
    `  required vars: IRC_NICK, IRC_USERNAME, IRC_PASSWORD\n` +
    `  optional vars: IRC_HOST (default: 127.0.0.1), IRC_PORT (default: 6667),\n` +
    `                 IRC_CHANNELS (default: #general), IRC_TLS (default: false)\n` +
    `                 IRC_GATE_CHANNEL (default: #gate)\n`,
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Notification throttle state (Tier 2)
// ---------------------------------------------------------------------------

const THROTTLE_WINDOW_MS = 30_000 // 30 seconds

type ThrottleEntry = {
  lastNotified: number
  buffered: number           // count of messages buffered since last notification
  lastNick: string           // nick of the most recent buffered message
  lastText: string           // text of the most recent buffered message
  bufferTimeout: ReturnType<typeof setTimeout> | null
}

const channelThrottle = new Map<string, ThrottleEntry>()

// ---------------------------------------------------------------------------
// IRC client
// ---------------------------------------------------------------------------

const client = new IRC.Client()

// Request IRCv3 capabilities needed for CHATHISTORY and batched responses
client.requestCap(['batch', 'draft/chathistory', 'server-time', 'message-tags'])

// Track joined channels so we only forward messages from channels we're in
const joinedChannels = new Set<string>()

// Track users in channels (from NAMES responses)
const channelUsers = new Map<string, Set<string>>()

// Pending NAMES response collectors
type PendingNames = {
  users: string[]
  resolve: (users: string[]) => void
  timer: ReturnType<typeof setTimeout>
}
const pendingNames = new Map<string, PendingNames>()

// Pending CHATHISTORY response collectors
// key: channel name (lowercased)
type HistoryMessage = { ts: string; nick: string; text: string }
type PendingHistory = {
  batchId: string | null
  messages: HistoryMessage[]
  resolve: (msgs: HistoryMessage[]) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}
const pendingHistory = new Map<string, PendingHistory>()

// Map batch ID -> channel key (for looking up pendingHistory during privmsg events)
const batchIdToChannel = new Map<string, string>()

// Pending TOPIC response collectors
type PendingTopic = {
  resolve: (topic: string) => void
  timer: ReturnType<typeof setTimeout>
}
const pendingTopics = new Map<string, PendingTopic>()

client.connect({
  host: IRC_HOST,
  port: IRC_PORT,
  nick: IRC_NICK!,
  username: IRC_USERNAME!,
  gecos: 'Claude Code smalltalk bridge',
  tls: IRC_TLS,
  // Reconnect automatically on disconnect, with exponential backoff
  auto_reconnect: true,
  auto_reconnect_wait: 3000,
  auto_reconnect_max_retries: 999, // effectively unlimited
  ...(IRC_USERNAME && IRC_PASSWORD
    ? {
        account: {
          account: IRC_USERNAME,
          password: IRC_PASSWORD,
        },
      }
    : {}),
})

client.on('registered', () => {
  ircConnected = true
  connectedAt = new Date()
  connectedToHost = `${IRC_HOST}:${IRC_PORT}`
  process.stderr.write(`smalltalk channel: connected as ${IRC_NICK} on ${IRC_HOST}:${IRC_PORT}\n`)
  for (const ch of IRC_CHANNELS) {
    client.join(ch)
  }
})

client.on('join', (event: { channel: string; nick: string }) => {
  if (event.nick === IRC_NICK) {
    const ch = event.channel.toLowerCase()
    joinedChannels.add(ch)
    process.stderr.write(`smalltalk channel: joined ${event.channel}\n`)
  }
  // Tier 3: join events — never notify
})

client.on('part', (event: { channel: string; nick: string }) => {
  if (event.nick === IRC_NICK) {
    joinedChannels.delete(event.channel.toLowerCase())
  }
  // Tier 3: part events — never notify
})

client.on('quit', (_event: { nick: string; message: string }) => {
  // Tier 3: quit events — never notify
})

// Collect NAMES responses for the who tool
client.on('userlist', (event: { channel: string; users: Array<{ nick: string; modes: string[] }> }) => {
  const ch = event.channel.toLowerCase()
  const users = new Set(event.users.map((u: { nick: string }) => u.nick))
  channelUsers.set(ch, users)

  const pending = pendingNames.get(ch)
  if (pending) {
    clearTimeout(pending.timer)
    pendingNames.delete(ch)
    pending.resolve(event.users.map((u: { nick: string }) => u.nick))
  }
})

client.on('kick', (event: { channel: string; kicked: string }) => {
  if (event.kicked === IRC_NICK) {
    joinedChannels.delete(event.channel.toLowerCase())
  }
  // Tier 3: kick events — never notify
})

// Collect TOPIC responses (332 on join, 332 on TOPIC request, 333 topicsetby)
client.on('topic', (event: { channel: string; topic: string; nick?: string }) => {
  const ch = event.channel.toLowerCase()
  const pending = pendingTopics.get(ch)
  if (pending) {
    clearTimeout(pending.timer)
    pendingTopics.delete(ch)
    pending.resolve(event.topic)
  }
})

let ircConnected = false
let connectedAt: Date | null = null
let connectedToHost = ''

client.on('reconnecting', (event: { attempt: number; max_retries: number; wait: number }) => {
  process.stderr.write(
    `smalltalk channel: reconnecting (attempt ${event.attempt}, wait ${Math.round(event.wait / 1000)}s)\n`
  )
})

client.on('close', () => {
  process.stderr.write('smalltalk channel: IRC connection closed\n')
  ircConnected = false
  joinedChannels.clear()
  // Fallback: if auto_reconnect doesn't trigger (e.g. too-fast disconnect),
  // schedule a manual reconnect after 5s
  setTimeout(() => {
    if (!ircConnected) {
      process.stderr.write('smalltalk channel: triggering manual reconnect\n')
      client.connect({
        host: IRC_HOST,
        port: IRC_PORT,
        nick: IRC_NICK!,
        username: IRC_USERNAME!,
        gecos: 'Claude Code smalltalk bridge',
        tls: IRC_TLS,
        auto_reconnect: true,
        auto_reconnect_wait: 3000,
        auto_reconnect_max_retries: 999,
        ...(IRC_USERNAME && IRC_PASSWORD
          ? { account: { account: IRC_USERNAME, password: IRC_PASSWORD } }
          : {}),
      })
    }
  }, 5000)
})

client.on('socket close', () => {
  ircConnected = false
  joinedChannels.clear()
})

// irc-framework processes BATCH internally: emits 'batch start', then fires
// all buffered commands as normal events (with event.batch set), then 'batch end'.
// We intercept chathistory batches by watching batch start/end and the batch
// field on privmsg events.

client.on('batch start chathistory', (event: { id: string; type: string; params: string[] }) => {
  // params[0] is the channel for chathistory batches
  const channel = (event.params[0] ?? '').toLowerCase()
  const pending = pendingHistory.get(channel)
  if (pending) {
    pending.batchId = event.id
    batchIdToChannel.set(event.id, channel)
  }
})

client.on('batch end chathistory', (event: { id: string; type: string; params: string[] }) => {
  const channel = batchIdToChannel.get(event.id)
  batchIdToChannel.delete(event.id)
  if (!channel) return

  const pending = pendingHistory.get(channel)
  if (!pending) return

  clearTimeout(pending.timer)
  pendingHistory.delete(channel)
  pending.resolve(pending.messages)
})

// Safely extract ISO timestamp from an IRC event's time field.
// irc-framework may return a Date, a string, or null depending on the context
// (e.g. CHATHISTORY batch events pass the raw @time tag as a string).
function getEventTs(time: Date | string | null | undefined): string {
  if (!time) return new Date().toISOString()
  if (time instanceof Date) return time.toISOString()
  // Already an ISO string from @time tag
  if (typeof time === 'string') return time
  return new Date().toISOString()
}

// Check if a message text contains a mention of our nick.
// Handles bare nick, @nick, and nick followed by punctuation (common IRC convention).
function isMention(text: string): boolean {
  if (!IRC_NICK) return false
  const nick = IRC_NICK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape regex special chars
  return new RegExp(`(?:^|\\s|@)${nick}(?:\\s|[,:!?]|$)`, 'i').test(text)
}

// Emit a Tier 1 (high priority) MCP notification immediately.
function emitHighPriority(opts: {
  content: string
  channel: string
  nick: string
  ts: string
  mention: boolean
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
      },
    },
  })
}

// Emit a Tier 2 (normal, throttled) batch summary notification.
function emitThrottledSummary(channel: string, entry: ThrottleEntry) {
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
      },
    },
  })

  entry.lastNotified = Date.now()
  entry.buffered = 0
  entry.bufferTimeout = null
}

// Handle inbound channel messages (also catches batched CHATHISTORY privmsgs)
client.on('privmsg', (event: {
  target: string
  nick: string
  message: string
  time: Date | string | null
  batch?: { id: string; type: string; params: string[] }
}) => {
  // ---------------------------------------------------------------------------
  // CHATHISTORY batch collection — always handled first, regardless of tier logic
  // ---------------------------------------------------------------------------
  if (event.batch?.type === 'chathistory') {
    const batchChannel = batchIdToChannel.get(event.batch.id)
    if (batchChannel) {
      const pending = pendingHistory.get(batchChannel)
      if (pending) {
        const ts = getEventTs(event.time)
        pending.messages.push({ ts, nick: event.nick, text: event.message })
      }
      return
    }
  }

  const ts = getEventTs(event.time)
  const targetLower = event.target.toLowerCase()
  const isChannelMsg = event.target.startsWith('#') || event.target.startsWith('&')
  const isDM = !isChannelMsg

  // ---------------------------------------------------------------------------
  // TIER 3: Own messages — always silent
  // ---------------------------------------------------------------------------
  if (event.nick === IRC_NICK) return

  // ---------------------------------------------------------------------------
  // TIER 1: Direct messages (PRIVMSG to our nick, not a channel)
  // ---------------------------------------------------------------------------
  if (isDM) {
    emitHighPriority({
      content: `[DM from ${event.nick}]: ${event.message}`,
      channel: 'dm',
      nick: event.nick,
      ts,
      mention: false,
    })
    return
  }

  // From here: channel message. Only forward from channels we've joined.
  if (!joinedChannels.has(targetLower)) return

  const channel = event.target

  // ---------------------------------------------------------------------------
  // TIER 1: #gate channel — always emit immediately, full content
  // ---------------------------------------------------------------------------
  if (targetLower === GATE_CHANNEL) {
    emitHighPriority({
      content: `[${channel}] <${event.nick}> ${event.message}`,
      channel,
      nick: event.nick,
      ts,
      mention: false,
    })
    return
  }

  // ---------------------------------------------------------------------------
  // TIER 1: Mentions — emit immediately even if the channel is throttled
  // ---------------------------------------------------------------------------
  if (isMention(event.message)) {
    emitHighPriority({
      content: `[MENTION] <${event.nick}> in ${channel}: ${event.message}`,
      channel,
      nick: event.nick,
      ts,
      mention: true,
    })
    // Do NOT fall through to Tier 2 — mention was already delivered.
    // The message will also show up via fetch_history if they want context.
    return
  }

  // ---------------------------------------------------------------------------
  // TIER 2: Normal channel message — throttled, max 1 notification per 30s
  // ---------------------------------------------------------------------------
  const now = Date.now()
  let entry = channelThrottle.get(targetLower)

  if (!entry) {
    entry = {
      lastNotified: 0,
      buffered: 0,
      lastNick: event.nick,
      lastText: event.message,
      bufferTimeout: null,
    }
    channelThrottle.set(targetLower, entry)
  }

  // Update the "most recent buffered message" info
  entry.buffered += 1
  entry.lastNick = event.nick
  entry.lastText = event.message

  const timeSinceLast = now - entry.lastNotified

  if (timeSinceLast >= THROTTLE_WINDOW_MS) {
    // Window expired — fire immediately and reset
    if (entry.bufferTimeout) {
      clearTimeout(entry.bufferTimeout)
      entry.bufferTimeout = null
    }
    emitThrottledSummary(targetLower, entry)
  } else {
    // Within throttle window — schedule a deferred batch notification if not already scheduled.
    // When the window expires, we fire one summary for everything buffered so far.
    if (!entry.bufferTimeout) {
      const delay = THROTTLE_WINDOW_MS - timeSinceLast
      entry.bufferTimeout = setTimeout(() => {
        const e = channelThrottle.get(targetLower)
        if (e && e.buffered > 0) {
          emitThrottledSummary(targetLower, e)
        }
      }, delay)
    }
    // else: timeout already scheduled, just let it fire when the window ends
  }
})

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'smalltalk', version: '0.1.0' },
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
      '    - [#gate] <nick> ... — a message in the coordination channel (#gate)',
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
      'WORKFLOW GUIDANCE:',
      '',
      '  - High-priority notifications (mentions, DMs, #gate) interrupt your current task.',
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
          channel: {
            type: 'string',
            description: 'IRC channel to send to, e.g. "#general"',
          },
          text: {
            type: 'string',
            description: 'Message text to send',
          },
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
          channel: {
            type: 'string',
            description: 'IRC channel to list users in, e.g. "#general"',
          },
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
          channel: {
            type: 'string',
            description: 'IRC channel to fetch history for, e.g. "#general"',
          },
          limit: {
            type: 'number',
            description: 'Number of messages to fetch (default: 50, max: 100)',
          },
        },
        required: ['channel'],
      },
    },
    {
      name: 'list_channels',
      description: 'List IRC channels you are currently joined to.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'status',
      description: 'Check the IRC connection status — whether you are connected, uptime, and which server.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'join',
      description: 'Join an additional IRC channel. Useful to subscribe to project-specific channels at runtime.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description: 'Channel to join, e.g. "#project-x"',
          },
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
          channel: {
            type: 'string',
            description: 'Channel to leave, e.g. "#project-x"',
          },
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
          channel: {
            type: 'string',
            description: 'IRC channel, e.g. "#project-x"',
          },
          text: {
            type: 'string',
            description: 'New topic to set. Omit to get the current topic.',
          },
        },
        required: ['channel'],
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

        if (!channel || !text) {
          throw new Error('channel and text are required')
        }

        if (!ircConnected) {
          throw new Error('not connected to IRC — server may be down, will reconnect automatically')
        }

        client.say(channel, text)
        return {
          content: [{ type: 'text', text: `sent to ${channel}` }],
        }
      }

      case 'dm': {
        const nick = args.nick as string
        const text = args.text as string
        if (!nick || !text) throw new Error('nick and text are required')
        if (!ircConnected) throw new Error('not connected to IRC')
        client.say(nick, text)
        return { content: [{ type: 'text', text: `DM sent to ${nick}` }] }
      }

      case 'who': {
        const channel = (args.channel as string).toLowerCase()
        if (!channel) throw new Error('channel is required')

        const users = await new Promise<string[]>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingNames.delete(channel)
            reject(new Error('NAMES request timed out'))
          }, 5_000)

          pendingNames.set(channel, { users: [], resolve, timer })
          client.raw(`NAMES ${channel}`)
        })

        if (users.length === 0) {
          return { content: [{ type: 'text', text: `no users in ${channel} (or not joined)` }] }
        }

        return {
          content: [{ type: 'text', text: `users in ${channel} (${users.length}): ${users.join(', ')}` }],
        }
      }

      case 'fetch_history': {
        const channel = (args.channel as string).toLowerCase()
        const limit = Math.min(Math.max(1, (args.limit as number | undefined) ?? 50), 100)

        if (!channel) {
          throw new Error('channel is required')
        }

        // If there's already a pending request for this channel, reject it first
        const existing = pendingHistory.get(channel)
        if (existing) {
          clearTimeout(existing.timer)
          existing.reject(new Error('superseded by new fetch_history request'))
          pendingHistory.delete(channel)
        }

        const messages = await new Promise<HistoryMessage[]>((resolve, reject) => {
          // Timeout after 10s — server may not support CHATHISTORY
          const timer = setTimeout(() => {
            pendingHistory.delete(channel)
            reject(new Error('CHATHISTORY request timed out — server may not support the chathistory capability'))
          }, 10_000)

          pendingHistory.set(channel, {
            batchId: null,
            messages: [],
            resolve,
            reject,
            timer,
          })

          // IRCv3 CHATHISTORY LATEST: fetch the N most recent messages
          // Format: CHATHISTORY LATEST <target> * <count>
          client.raw(`CHATHISTORY LATEST ${channel} * ${limit}`)
        })

        if (messages.length === 0) {
          return {
            content: [{ type: 'text', text: `no history available for ${channel}` }],
          }
        }

        const formatted = messages
          .map((m: HistoryMessage) => `[${m.ts}] <${m.nick}> ${m.text}`)
          .join('\n')

        return {
          content: [
            {
              type: 'text',
              text: `${messages.length} message(s) from ${channel}:\n\n${formatted}`,
            },
          ],
        }
      }

      case 'join': {
        const channel = args.channel as string
        if (!channel || !channel.startsWith('#')) {
          throw new Error('channel is required and must start with #')
        }
        if (!ircConnected) throw new Error('not connected to IRC')
        if (joinedChannels.has(channel.toLowerCase())) {
          return { content: [{ type: 'text', text: `already in ${channel}` }] }
        }
        client.join(channel)
        // Wait up to 3s for join confirmation
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 3_000)
          const check = setInterval(() => {
            if (joinedChannels.has(channel.toLowerCase())) {
              clearInterval(check)
              clearTimeout(timeout)
              resolve()
            }
          }, 100)
        })
        if (joinedChannels.has(channel.toLowerCase())) {
          return { content: [{ type: 'text', text: `joined ${channel}` }] }
        }
        return { content: [{ type: 'text', text: `join sent to ${channel} — may need permissions` }] }
      }

      case 'part': {
        const channel = args.channel as string
        if (!channel || !channel.startsWith('#')) {
          throw new Error('channel is required and must start with #')
        }
        if (!ircConnected) throw new Error('not connected to IRC')
        if (!joinedChannels.has(channel.toLowerCase())) {
          return { content: [{ type: 'text', text: `not in ${channel}` }] }
        }
        client.part(channel)
        return { content: [{ type: 'text', text: `left ${channel}` }] }
      }

      case 'topic': {
        const channel = args.channel as string
        if (!channel || !channel.startsWith('#')) {
          throw new Error('channel is required and must start with #')
        }
        if (!ircConnected) throw new Error('not connected to IRC')

        const newTopic = args.text as string | undefined

        if (newTopic !== undefined) {
          // Set topic
          client.setTopic(channel, newTopic)
          return { content: [{ type: 'text', text: `topic set in ${channel}` }] }
        }

        // Get topic — send TOPIC command and wait for server reply
        const chLower = channel.toLowerCase()
        const topic = await new Promise<string>((resolve) => {
          const timer = setTimeout(() => {
            pendingTopics.delete(chLower)
            resolve('(no topic set)')
          }, 5_000)
          pendingTopics.set(chLower, { resolve, timer })
          client.raw(`TOPIC ${channel}`)
        })

        const topicText = topic === '' ? '(no topic set)' : topic
        return { content: [{ type: 'text', text: `topic in ${channel}: ${topicText}` }] }
      }

      case 'list_channels': {
        const channels = Array.from(joinedChannels)
        if (channels.length === 0) {
          return { content: [{ type: 'text', text: 'not currently joined to any channels' }] }
        }
        return {
          content: [{ type: 'text', text: `joined channels (${channels.length}): ${channels.join(', ')}` }],
        }
      }

      case 'status': {
        if (!ircConnected) {
          return {
            content: [{ type: 'text', text: 'disconnected — reconnecting automatically. Use fetch_history when back online.' }],
          }
        }
        const uptimeMs = connectedAt ? Date.now() - connectedAt.getTime() : 0
        const uptimeSec = Math.floor(uptimeMs / 1000)
        const uptimeStr = uptimeSec < 60
          ? `${uptimeSec}s`
          : uptimeSec < 3600
          ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
          : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`
        const channels = Array.from(joinedChannels)
        return {
          content: [{
            type: 'text',
            text: `connected to ${connectedToHost} as ${IRC_NICK} (uptime: ${uptimeStr}, channels: ${channels.join(', ') || 'none'})`,
          }],
        }
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
// Clean shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string) {
  process.stderr.write(`smalltalk channel: received ${signal}, disconnecting...\n`)
  try {
    client.quit('Claude Code shutting down')
  } catch {}
  setTimeout(() => process.exit(0), 500)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Prevent unhandled errors from killing the process unexpectedly
process.on('uncaughtException', (err: Error) => {
  process.stderr.write(`smalltalk channel: uncaught error: ${err.message}\n`)
})
process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(`smalltalk channel: unhandled rejection: ${reason}\n`)
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

await mcp.connect(new StdioServerTransport())

process.stderr.write(
  `smalltalk channel: MCP server ready\n` +
  `  IRC: ${IRC_HOST}:${IRC_PORT} (TLS: ${IRC_TLS})\n` +
  `  nick: ${IRC_NICK}\n` +
  `  channels: ${IRC_CHANNELS.join(', ')}\n` +
  `  gate channel: ${GATE_CHANNEL}\n`,
)
