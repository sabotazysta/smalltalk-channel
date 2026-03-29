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

  // Callbacks that consumers can hook into to react to IRC events per-connection.
  // server.ts sets these up after constructing the pool.
  public onMessage?: (conn: Connection, event: {
    target: string
    nick: string
    message: string
    time: Date | string | null
    batch?: { id: string; type: string; params: string[] }
  }) => void

  public onRegistered?: (conn: Connection) => void
  public onJoin?: (conn: Connection, event: { channel: string; nick: string }) => void
  public onPart?: (conn: Connection, event: { channel: string; nick: string }) => void
  public onQuit?: (conn: Connection, event: { nick: string; message: string }) => void
  public onKick?: (conn: Connection, event: { channel: string; kicked: string }) => void
  public onReconnecting?: (conn: Connection, event: { attempt: number; max_retries: number; wait: number }) => void
  public onClose?: (conn: Connection) => void
  public onSocketClose?: (conn: Connection) => void
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
    }

    this.connections.set(key, conn)

    // Wire up event forwarding before connecting
    client.on('registered', () => {
      conn.status = 'connected'
      conn.connectedAt = new Date()
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

    client.on('close', () => {
      conn.status = 'disconnected'
      conn.channels.clear()
      this.onClose?.(conn)
    })

    client.on('socket close', () => {
      conn.status = 'disconnected'
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
      ...(config.websocket ? { transport: wsTransport } : {}),
      ...(config.username && config.password
        ? { account: { account: config.username, password: config.password } }
        : {}),
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
