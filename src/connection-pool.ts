/**
 * ConnectionPool — manages multiple simultaneous IRC server connections.
 *
 * Key behaviors:
 * - First connected server becomes primary automatically.
 * - resolve(undefined) returns primary, throws if none.
 * - resolve("irc.smalltalk.chat") looks up by host (flexible: strips wss:// or ws:// prefix).
 * - disconnect cleans up; if primary was removed, promotes next available.
 */

import IRC from 'irc-framework'
import wsTransport from 'irc-framework/src/transports/websocket.js'

export interface ConnectionConfig {
  host: string
  port: number
  nick: string
  username?: string
  password: string
  tls?: boolean
  websocket?: boolean
  channels?: string[]
  gateChannel?: string
  skills?: string
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export interface Connection {
  config: ConnectionConfig
  client: InstanceType<typeof IRC.Client>
  channels: Set<string>
  status: ConnectionStatus
  connectedAt: Date | null
  /** ms epoch when we last became non-connected (or started connecting); watchdog input. */
  disconnectedAt: number
  /** pending forced-reconnect timer (set by our close handler); cleared by disconnect(). */
  reconnectTimer: ReturnType<typeof setTimeout> | null
  /** true once disconnect() was called -- close events must never trigger a reconnect. */
  closing: boolean
}

// Strip protocol prefixes to get a bare host for use as map key.
function normalizeHost(host: string): string {
  return host.replace(/^wss?:\/\//i, '').replace(/^ircs?:\/\//i, '').toLowerCase()
}

// Canonical key for a connection: host:port (no protocol prefix, lowercase).
function normalizeKey(host: string, port: number): string {
  return normalizeHost(host) + ':' + port
}

// Resolve a user-supplied server string to a connection Map key.
// Accepts "host:port" (preferred when two servers share the same host),
// or bare "host" (resolves to the first connection on that host).
function resolveKey(connections: Map<string, Connection>, server: string): string | null {
  const bare = normalizeHost(server)
  // Exact match — works for both "host:port" and legacy "host" keys
  if (connections.has(bare)) return bare
  // Prefix search: bare host matches "host:NNNN"
  const prefix = bare + ':'
  for (const k of connections.keys()) {
    if (k.startsWith(prefix)) return k
  }
  return null
}

export class ConnectionPool {
  private connections = new Map<string, Connection>()
  private primaryHost: string | null = null
  // Consecutive failed (re)connects per key, for our own backoff. Reset once a
  // registered session survives > SAFE_SESSION_MS.
  private failures = new Map<string, number>()
  private watchdog: ReturnType<typeof setInterval> | null = null
  public stuckAfterMs = 5 * 60_000
  public watchdogIntervalMs = 30_000
  public baseWaitMs = 3000

  // Callbacks that consumers can hook into to react to IRC events per-connection.
  // server.ts sets these up after constructing the pool.
  public onMessage?: (conn: Connection, event: {
    target: string
    nick: string
    message: string
    time: Date | string | null
    tags?: Record<string, string>
    batch?: { id: string; type: string; params: string[] }
  }) => void

  public onRegistered?: (conn: Connection) => void
  public onJoin?: (conn: Connection, event: { channel: string; nick: string }) => void
  public onPart?: (conn: Connection, event: { channel: string; nick: string }) => void
  public onQuit?: (conn: Connection, event: { nick: string; message: string }) => void
  public onKick?: (conn: Connection, event: { channel: string; kicked: string }) => void
  public onReconnecting?: (conn: Connection, event: { attempt: number; max_retries: number; wait: number }) => void
  public onClose?: (conn: Connection) => void
  public onStuck?: (conn: Connection, event: { disconnectedForMs: number }) => void
  public onSocketClose?: (conn: Connection) => void
  public onClientError?: (conn: Connection, err: Error) => void
  public onPreRegRaw?: (conn: Connection, line: string) => void
  public onUserlist?: (conn: Connection, event: { channel: string; users: Array<{ nick: string; modes: string[] }> }) => void
  public onTopic?: (conn: Connection, event: { channel: string; topic: string; nick?: string }) => void
  public onBatchStartChathistory?: (conn: Connection, event: { id: string; type: string; params: string[] }) => void
  public onBatchEndChathistory?: (conn: Connection, event: { id: string; type: string; params: string[] }) => void

  async connect(config: ConnectionConfig): Promise<void> {
    const key = normalizeKey(config.host, config.port)

    if (this.connections.has(key)) {
      throw new Error(`already connected to ${config.host}:${config.port}`)
    }

    const client = new IRC.Client()

    // Request IRCv3 capabilities needed for CHATHISTORY and batched responses
    // Request both draft/ and non-draft variants for compatibility across IRC servers
    client.requestCap(['batch', 'draft/batch', 'draft/chathistory', 'server-time', 'draft/server-time', 'message-tags'])

    const conn: Connection = {
      config,
      client,
      channels: new Set<string>(),
      status: 'connecting',
      connectedAt: null,
      disconnectedAt: Date.now(),
      reconnectTimer: null,
      closing: false,
    }
    this.startWatchdog()

    this.connections.set(key, conn)

    // Diagnostic (2026-08-13, live incident): while never-registered, surface
    // every raw line from the server -- this is the only way to see a SASL
    // failure numeric / ERROR line / rate-limit reply that closes the socket
    // server-side without ever raising a client-side error. Stops listening
    // once registered so normal operation isn't spammed.
    client.on('raw', (event: { line: string; from_server: boolean }) => {
      if (event.from_server && conn.status !== 'connected') {
        this.onPreRegRaw?.(conn, event.line)
      }
    })

    // Wire up event forwarding before connecting
    client.on('registered', () => {
      conn.status = 'connected'
      conn.connectedAt = new Date()
      conn.disconnectedAt = 0
      // Bug #3: set primaryHost only after successful registration, not before connect()
      if (this.primaryHost === null) {
        this.primaryHost = key  // key is now host:port
      }
      this.onRegistered?.(conn)
    })

    client.on('join', (event: { channel: string; nick: string }) => {
      if (event.nick === config.nick) {
        conn.channels.add(event.channel.toLowerCase())
      }
      this.onJoin?.(conn, event)
    })

    client.on('invite', (event: { channel: string; nick: string }) => {
      // Auto-join when invited — handles invite-only (+i) channels
      client.join(event.channel)
    })

    client.on('part', (event: { channel: string; nick: string }) => {
      if (event.nick === config.nick) {
        conn.channels.delete(event.channel.toLowerCase())
      }
      this.onPart?.(conn, event)
    })

    client.on('quit', (event: { nick: string; message: string }) => {
      this.onQuit?.(conn, event)
    })

    client.on('kick', (event: { channel: string; kicked: string }) => {
      if (event.kicked === config.nick) {
        conn.channels.delete(event.channel.toLowerCase())
      }
      this.onKick?.(conn, event)
    })

    client.on('userlist', (event: { channel: string; users: Array<{ nick: string; modes: string[] }> }) => {
      this.onUserlist?.(conn, event)
    })

    client.on('topic', (event: { channel: string; topic: string; nick?: string }) => {
      this.onTopic?.(conn, event)
    })

    client.on('privmsg', (event: {
      target: string
      nick: string
      message: string
      time: Date | string | null
      tags?: Record<string, string>
      batch?: { id: string; type: string; params: string[] }
    }) => {
      this.onMessage?.(conn, event)
    })

    client.on('batch start chathistory', (event: { id: string; type: string; params: string[] }) => {
      this.onBatchStartChathistory?.(conn, event)
    })
    // Also handle draft/chathistory batch type (used by some IRC servers including ergo)
    client.on('batch start draft/chathistory', (event: { id: string; type: string; params: string[] }) => {
      this.onBatchStartChathistory?.(conn, event)
    })

    client.on('batch end chathistory', (event: { id: string; type: string; params: string[] }) => {
      this.onBatchEndChathistory?.(conn, event)
    })
    client.on('batch end draft/chathistory', (event: { id: string; type: string; params: string[] }) => {
      this.onBatchEndChathistory?.(conn, event)
    })

    client.on('reconnecting', (event: { attempt: number; max_retries: number; wait: number }) => {
      this.onReconnecting?.(conn, event)
    })

    client.on('close', (maybeErr?: Error | false) => {
      conn.status = 'disconnected'
      conn.channels.clear()
      // websocket transport passes the last socket error (or `false`) as the
      // close event's argument -- previously discarded entirely, which is why
      // a stuck-registration loop showed as a bare "CLOSE ... never-registered"
      // with zero indication of WHY (2026-08-13 incident).
      if (maybeErr) {
        this.onClientError?.(conn, maybeErr)
      }
      this.onClose?.(conn)
      // Self-heal for an irc-framework gap (floppy flap 2026-08-12/13; bandit 2026-10-21):
      // 'close' means irc-framework gave up. It reconnects only if reconnect_attempts > 0
      // OR (was_connected && registered > 5 s ago), so a first attempt that dies before
      // registering, OR a session that registers and drops within 5 s (reconnect_attempts
      // was reset to 0 by the socket opening), is abandoned forever. The old workaround
      // only covered connectedAt === null and missed the second case. Now: ANY 'close'
      // that we did not initiate (disconnect() sets conn.closing) schedules a retry.
      if (!conn.closing && this.connections.get(key) === conn) {
        this.scheduleReconnect(key, conn)
      }
    })

    client.on('socket close', () => {
      conn.status = 'disconnected'
      if (!conn.disconnectedAt) conn.disconnectedAt = Date.now()
      conn.channels.clear()
      this.onSocketClose?.(conn)
    })

    // Initiate the connection
    client.connect({
      host: config.host,
      port: config.port,
      nick: config.nick,
      username: config.username ?? config.nick,
      gecos: 'Claude Code smalltalk bridge',
      tls: config.tls ?? false,
      auto_reconnect: true,
      auto_reconnect_wait: 3000,
      auto_reconnect_max_retries: 999,
      message_max_length: 4096,
      ...(config.websocket ? { transport: wsTransport } : {}),
      ...(config.username && config.password
        ? { account: { account: config.username, password: config.password } }
        : {}),
    })

  }

  private scheduleReconnect(key: string, conn: Connection): void {
    if (conn.reconnectTimer) return // already pending -> never double-schedule
    if (conn.connectedAt && Date.now() - conn.connectedAt.getTime() > 5000) {
      this.failures.set(key, 0)
    }
    const n = this.failures.get(key) ?? 0
    this.failures.set(key, n + 1)
    const wait = Math.min(this.baseWaitMs * 2 ** Math.min(n, 5), 60_000) + Math.floor(Math.random() * 1000)
    if (!conn.disconnectedAt) conn.disconnectedAt = Date.now()
    this.onReconnecting?.(conn, { attempt: n + 1, max_retries: 999, wait })
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null
      this.reconnectNow(key, conn)
    }, wait)
  }

  // Replace a dead connection with a fresh one. Guarded so a stale timer can never
  // clobber a connection that was disconnected or replaced in the meantime.
  private reconnectNow(key: string, conn: Connection): void {
    if (conn.closing || this.connections.get(key) !== conn) return
    if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null }
    conn.closing = true // old client's late events must not schedule anything
    try { conn.client.options.auto_reconnect = false } catch {}
    conn.client.removeAllListeners()
    try { (conn.client as any).end?.() } catch {}
    this.connections.delete(key)
    this.connect(conn.config).catch(() => {
      // synchronous setup failure: put a placeholder-free retry on the books
      setTimeout(() => this.connect(conn.config).catch(() => {}), this.baseWaitMs)
    })
  }

  private startWatchdog(): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => this.checkStuck(), this.watchdogIntervalMs)
    ;(this.watchdog as any).unref?.()
  }

  /** Force one reconnect for connections non-connected > stuckAfterMs with no retry pending. */
  checkStuck(now = Date.now()): void {
    for (const [key, conn] of Array.from(this.connections)) {
      if (conn.closing || conn.status === 'connected' || conn.reconnectTimer) continue
      if (!conn.disconnectedAt || now - conn.disconnectedAt <= this.stuckAfterMs) continue
      this.onStuck?.(conn, { disconnectedForMs: now - conn.disconnectedAt })
      this.reconnectNow(key, conn)
    }
  }

  /**
   * Ask the server which channels WE are actually in, via `WHOIS <own nick>` ->
   * numeric 319 (RPL_WHOISCHANNELS). Resolves with the raw, space-separated,
   * still-prefixed channel string (e.g. `"#public @#dexter #general"`), or
   * `null` if the server told us nothing in time.
   *
   * WHY: JOIN echoes are not a reliable source of truth. Ergo with `always-on`
   * sends no JOIN echo to a client that is already a member, so a client that
   * rebuilds membership purely from echoes believes it is in zero channels
   * forever after a restart (doctor, 2026-08-15). The server always knows.
   *
   * irc-framework already parses 319 into the `channels` field of the `whois`
   * event and emits it on 318 (RPL_ENDOFWHOIS), so no raw-numeric handler is
   * needed here — but `client.whois()`'s own callback never fires (and leaks its
   * listener) if 318 never arrives, hence this bounded version.
   *
   * Never rejects and never blocks anything: a timeout resolves `null`, which
   * callers must treat as "learned nothing", NOT as "in no channels".
   */
  whoisOwnChannels(conn: Connection, timeoutMs = 10_000): Promise<string | null> {
    return new Promise((resolve) => {
      const nick = conn.config.nick.toLowerCase()
      let settled = false

      const finish = (value: string | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        conn.client.removeListener('whois', onWhois)
        resolve(value)
      }

      const onWhois = (event: { nick?: string; channels?: string }) => {
        if (event?.nick?.toLowerCase() === nick) finish(event.channels ?? null)
      }

      const timer = setTimeout(() => finish(null), timeoutMs)
      conn.client.on('whois', onWhois)
      try {
        conn.client.raw(`WHOIS ${conn.config.nick}`)
      } catch {
        finish(null)
      }
    })
  }

  async disconnect(host: string): Promise<void> {
    const key = resolveKey(this.connections, host)
    if (!key) {
      throw new Error(`no connection to ${host}`)
    }
    const conn = this.connections.get(key)!
    if (!conn) {
      throw new Error(`no connection to ${host}`)
    }

    conn.closing = true
    if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null }
    // Bug #1: disable auto_reconnect before quitting to prevent zombie reconnects
    try {
      conn.client.options.auto_reconnect = false
    } catch {}

    try {
      conn.client.quit('disconnect requested')
    } catch {}

    // Give the client a moment to send QUIT before destroying the socket
    await new Promise(r => setTimeout(r, 500))

    conn.client.removeAllListeners()
    try {
      ;(conn.client as any).end?.()
    } catch {}

    conn.status = 'disconnected'
    this.connections.delete(key)

    // If this was primary, promote next available
    if (this.primaryHost === key) {
      const next = this.connections.keys().next()
      this.primaryHost = next.done ? null : next.value
    }
  }

  resolve(server?: string): Connection {
    if (server === undefined || server === null || server === '') {
      // Return primary
      if (this.primaryHost === null) {
        throw new Error('no IRC server connected — call connect first or set IRC_HOST/IRC_NICK/IRC_PASSWORD env vars')
      }
      const conn = this.connections.get(this.primaryHost)
      if (!conn) {
        throw new Error('primary server connection lost')
      }
      // Bug #2: don't return dead connections silently
      if (conn.status !== 'connected') {
        throw new Error(`primary connection is not ready (status: ${conn.status})`)
      }
      return conn
    }

    const key = resolveKey(this.connections, server)
    if (!key) {
      const available = Array.from(this.connections.keys()).join(', ') || 'none'
      throw new Error(`no connection to server "${server}" (available: ${available})`)
    }
    const conn = this.connections.get(key)!
    // Bug #2: don't return dead connections silently
    if (conn.status !== 'connected') {
      throw new Error(`connection to ${server} is not ready (status: ${conn.status})`)
    }
    return conn
  }

  setPrimary(host: string): void {
    const key = resolveKey(this.connections, host)
    if (!key) {
      throw new Error(`no connection to ${host}`)
    }
    this.primaryHost = key
  }

  getPrimary(): Connection | null {
    if (this.primaryHost === null) return null
    return this.connections.get(this.primaryHost) ?? null
  }

  getAll(): Connection[] {
    return Array.from(this.connections.values())
  }

  getStatus(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, conn] of this.connections) {
      result[key] = conn.status
    }
    return result
  }

  size(): number {
    return this.connections.size
  }
}
