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

export class TypingTracker {
  // Targets (lowercased nick) we've sent `active` to and not yet `done`.
  // timer === null means `paused` was already sent; still awaiting `done` on reply.
  private pending = new Map<string, { client: TypingClient; target: string; timer: ReturnType<typeof setTimeout> | null }>()

  constructor(private opts: { enabled: boolean; pausedAfterMs?: number }) {}

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
    if (isServiceNick(nick) || nick.toLowerCase() === myNick.toLowerCase()) return
    const key = nick.toLowerCase()
    const prev = this.pending.get(key)
    if (prev?.timer) clearTimeout(prev.timer)
    this.send(client, nick, 'active')
    const timer = setTimeout(() => {
      const entry = this.pending.get(key)
      if (!entry || entry.timer !== timer) return
      entry.timer = null
      this.send(entry.client, entry.target, 'paused')
    }, this.opts.pausedAfterMs ?? 60_000)
    this.pending.set(key, { client, target: nick, timer })
  }

  /** The agent is about to send a message to `target` — call BEFORE the PRIVMSG. */
  onReplySent(client: TypingClient, target: string): void {
    const key = target.toLowerCase()
    const entry = this.pending.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    this.pending.delete(key)
    this.send(client, target, 'done')
  }
}
