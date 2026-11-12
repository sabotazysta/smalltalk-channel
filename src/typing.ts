// IRCv3 typing indicators as a delivery receipt (`+typing` client tag on TAGMSG).
//
// On Telegram the channel plugin shows "typing…" the moment a message reaches the agent.
// This gives IRC the same signal: when a DM is forwarded to the session we send
// `+typing=active` to the sender; when the agent replies (dm/send tool) we send
// `+typing=done`; if no reply comes within `pausedAfterMs` we send `+typing=paused` once.
// We signal RECEIPT, not continuous typing — `active` is never re-sent on a timer.
//
// Kept out of server.ts so it can be unit-tested (server.ts can't be imported from a test:
// top-level `await mcp.connect(transport)`).

// The slice of irc-framework's Client we use.
export interface TypingClient {
  network: { cap: { isEnabled(cap: string): boolean } }
  tagmsg(target: string, tags: Record<string, string>): void
}

export type TypingState = 'active' | 'paused' | 'done'

// Services never get typing notifications (they'd ignore or complain).
const SERVICE_NICKS = new Set([
  'nickserv', 'chanserv', 'memoserv', 'hostserv', 'botserv', 'operserv', 'histserv', 'global',
])

export function isServiceNick(nick: string): boolean {
  // Server-originated messages carry a server name (contains a dot) or no nick at all.
  return !nick || nick.includes('.') || SERVICE_NICKS.has(nick.toLowerCase())
}

// Default ack policy: never to ourselves, services or server names. A future allowlist
// belongs here too — it runs as the FIRST check in onDmReceived.
export function defaultShouldAck(nick: string, myNick: string): boolean {
  return !isServiceNick(nick) && nick.toLowerCase() !== myNick.toLowerCase()
}

export class TypingTracker {
  // Targets (lowercased nick) we've sent `active` to and not yet `done`/`paused`.
  private pending = new Map<string, {
    client: TypingClient
    target: string
    timer: ReturnType<typeof setTimeout>
    lastActiveAt: number
  }>()

  private shouldAck: (nick: string, myNick: string) => boolean

  constructor(private opts: {
    enabled: boolean
    pausedAfterMs?: number      // default 60 s
    activeMinIntervalMs?: number // default 2 s: at most one `active` per nick per interval
    shouldAck?: (nick: string, myNick: string) => boolean
  }) {
    this.shouldAck = opts.shouldAck ?? defaultShouldAck
  }

  private send(client: TypingClient, target: string, state: TypingState): void {
    try {
      if (!client.network.cap.isEnabled('message-tags')) return
      client.tagmsg(target, { '+typing': state })
    } catch (e) {
      process.stderr.write(`smalltalk: typing ${state} to ${target} failed: ${e}\n`)
    }
  }

  /** A DM from `nick` was just forwarded to the session. */
  onDmReceived(client: TypingClient, myNick: string, nick: string): void {
    if (!this.opts.enabled) return
    try {
      if (!this.shouldAck(nick, myNick)) return
    } catch {
      return
    }
    const key = nick.toLowerCase()
    const now = Date.now()
    const prev = this.pending.get(key)
    if (prev) clearTimeout(prev.timer)
    // Rate limit: a burst of DMs must not echo one TAGMSG each — but the timer still resets.
    let lastActiveAt = prev?.lastActiveAt ?? 0
    if (!prev || now - prev.lastActiveAt >= (this.opts.activeMinIntervalMs ?? 2_000)) {
      this.send(client, nick, 'active')
      lastActiveAt = now
    }
    const timer = setTimeout(() => {
      const entry = this.pending.get(key)
      if (!entry || entry.timer !== timer) return
      this.pending.delete(key)
      this.send(entry.client, entry.target, 'paused')
    }, this.opts.pausedAfterMs ?? 60_000)
    timer.unref?.()  // never keep the process alive just for a pending `paused`
    this.pending.set(key, { client, target: nick, timer, lastActiveAt })
  }

  /** The agent is about to send a message to `target` — call BEFORE the PRIVMSG. */
  onReplySent(client: TypingClient, target: string): void {
    const key = target.toLowerCase()
    const entry = this.pending.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(key)
    this.send(client, target, 'done')
  }

  /** Test hook: number of nicks awaiting done/paused. */
  pendingCount(): number {
    return this.pending.size
  }
}
