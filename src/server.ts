#!/usr/bin/env bun
/**
 * smalltalk-channel — IRC bridge for Claude Code.
 *
 * MCP server exposing IRC as a Claude channel. Connects to an IRC server via
 * irc-framework, joins configured channels, and bridges inbound messages as
 * MCP notifications. Exposes `send` and `fetch_history` tools.
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
    `                 IRC_CHANNELS (default: #general), IRC_TLS (default: false)\n`,
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// IRC client
// ---------------------------------------------------------------------------

const client = new IRC.Client()

// Request IRCv3 capabilities needed for CHATHISTORY and batched responses
client.requestCap(['batch', 'draft/chathistory', 'server-time', 'message-tags'])

// Track joined channels so we only forward messages from channels we're in
const joinedChannels = new Set<string>()

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

// Map batch ID → channel key (for looking up pendingHistory during privmsg events)
const batchIdToChannel = new Map<string, string>()

client.connect({
  host: IRC_HOST,
  port: IRC_PORT,
  nick: IRC_NICK!,
  username: IRC_USERNAME!,
  gecos: 'Claude Code smalltalk bridge',
  tls: IRC_TLS,
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
})

client.on('part', (event: { channel: string; nick: string }) => {
  if (event.nick === IRC_NICK) {
    joinedChannels.delete(event.channel.toLowerCase())
  }
})

client.on('kick', (event: { channel: string; kicked: string }) => {
  if (event.kicked === IRC_NICK) {
    joinedChannels.delete(event.channel.toLowerCase())
  }
})

client.on('close', () => {
  process.stderr.write('smalltalk channel: IRC connection closed, will reconnect...\n')
  joinedChannels.clear()
})

client.on('socket close', () => {
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

// Handle inbound channel messages (also catches batched CHATHISTORY privmsgs)
client.on('privmsg', (event: {
  target: string
  nick: string
  message: string
  time: Date | string | null
  batch?: { id: string; type: string; params: string[] }
}) => {
  const channel = event.target

  // If this message belongs to a chathistory batch, collect it and skip normal delivery
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

  // Only handle messages to channels (not PMs)
  if (!channel.startsWith('#') && !channel.startsWith('&')) return
  // Drop our own messages
  if (event.nick === IRC_NICK) return
  // Only forward from channels we've joined
  if (!joinedChannels.has(channel.toLowerCase())) return

  const ts = getEventTs(event.time)

  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: `<${event.nick}> ${event.message}`,
      meta: {
        channel,
        nick: event.nick,
        ts,
      },
    },
  })
})

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'smalltalk', version: '0.0.1' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'You are connected to an IRC server via the smalltalk channel plugin.',
      '',
      'Messages from IRC arrive as <channel source="smalltalk" channel="..." nick="..." ts="...">.',
      'The content is formatted as "<nick> message text".',
      '',
      'Use the `send` tool to post a message to a channel — pass the channel name (e.g. "#general") and your message text.',
      '',
      'Use `fetch_history` to retrieve recent messages from a channel when you need context.',
      'This uses IRCv3 CHATHISTORY — the IRC server must support the chathistory capability.',
      '',
      'IRC is a multi-user chat environment — messages are visible to everyone in the channel.',
      'Multiple people may be talking; pay attention to the nick in each message.',
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

        client.say(channel, text)
        return {
          content: [{ type: 'text', text: `sent to ${channel}` }],
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
// Start
// ---------------------------------------------------------------------------

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

await mcp.connect(new StdioServerTransport())

process.stderr.write(
  `smalltalk channel: MCP server ready\n` +
  `  IRC: ${IRC_HOST}:${IRC_PORT} (TLS: ${IRC_TLS})\n` +
  `  nick: ${IRC_NICK}\n` +
  `  channels: ${IRC_CHANNELS.join(', ')}\n`,
)
