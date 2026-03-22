/**
 * logger.ts — message & event logging for the smalltalk MCP plugin.
 *
 * Opens/creates a SQLite database at a configurable path and provides:
 *   log(msg)       — record a channel message or DM
 *   logEvent(evt)  — record a user event (join/part/quit)
 *
 * The logger is optional. If the DB path is not set (LOG_DB env var or
 * explicit path arg), logging is a no-op so the plugin still runs fine.
 *
 * Schema:
 *   messages — every PRIVMSG seen (channel + DMs sent/received)
 *   events   — join/part/quit with timestamps
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessageDirection = 'inbound' | 'outbound'
export type MessageKind = 'channel' | 'dm'

export interface LogMessage {
  ts?: string              // ISO 8601 — defaults to now
  nick: string             // sender nick
  target: string           // channel name (#general) or recipient nick (DMs)
  text: string             // message content
  kind: MessageKind        // 'channel' | 'dm'
  direction: MessageDirection // 'inbound' (received) | 'outbound' (sent by us)
  server_host: string      // IRC server host, e.g. "irc.smalltalk.chat"
}

export type UserEventType = 'join' | 'part' | 'quit' | 'kick' | 'nick_change'

export interface LogEvent {
  ts?: string
  nick: string
  event_type: UserEventType
  channel?: string         // relevant for join/part/kick
  detail?: string          // quit message, kick reason, new nick, etc.
  server_host: string
}

// ---------------------------------------------------------------------------
// Internal DB handle — null when logging is disabled
// ---------------------------------------------------------------------------

let _db: Database | null = null
let _serverHost = ''

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,               -- ISO 8601 UTC
  nick        TEXT    NOT NULL,               -- sender nick
  target      TEXT    NOT NULL,               -- #channel or nick (for DMs)
  text        TEXT    NOT NULL,               -- message body
  kind        TEXT    NOT NULL CHECK(kind IN ('channel','dm')),
  direction   TEXT    NOT NULL CHECK(direction IN ('inbound','outbound')),
  server_host TEXT    NOT NULL                -- IRC server hostname
);

CREATE INDEX IF NOT EXISTS idx_messages_ts          ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_messages_nick        ON messages(nick);
CREATE INDEX IF NOT EXISTS idx_messages_target      ON messages(target);
CREATE INDEX IF NOT EXISTS idx_messages_server_host ON messages(server_host);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  nick        TEXT    NOT NULL,
  event_type  TEXT    NOT NULL CHECK(event_type IN ('join','part','quit','kick','nick_change')),
  channel     TEXT,                           -- NULL for quit/nick_change
  detail      TEXT,                           -- quit msg, kick reason, new nick
  server_host TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts          ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_nick        ON events(nick);
CREATE INDEX IF NOT EXISTS idx_events_server_host ON events(server_host);

-- Materialised per-channel stats kept up to date by triggers.
-- Avoids expensive COUNT(*) scans at dashboard query time.
CREATE TABLE IF NOT EXISTS channel_stats (
  channel     TEXT    NOT NULL,
  server_host TEXT    NOT NULL,
  message_count  INTEGER NOT NULL DEFAULT 0,
  last_message_ts TEXT,
  PRIMARY KEY (channel, server_host)
);

CREATE TRIGGER IF NOT EXISTS trg_channel_stats_insert
AFTER INSERT ON messages
WHEN NEW.kind = 'channel'
BEGIN
  INSERT INTO channel_stats (channel, server_host, message_count, last_message_ts)
    VALUES (NEW.target, NEW.server_host, 1, NEW.ts)
  ON CONFLICT(channel, server_host) DO UPDATE SET
    message_count   = message_count + 1,
    last_message_ts = NEW.ts;
END;

-- Per-user activity summary
CREATE TABLE IF NOT EXISTS user_stats (
  nick        TEXT    NOT NULL,
  server_host TEXT    NOT NULL,
  message_count  INTEGER NOT NULL DEFAULT 0,
  last_seen_ts   TEXT,
  first_seen_ts  TEXT,
  PRIMARY KEY (nick, server_host)
);

CREATE TRIGGER IF NOT EXISTS trg_user_stats_insert
AFTER INSERT ON messages
BEGIN
  INSERT INTO user_stats (nick, server_host, message_count, last_seen_ts, first_seen_ts)
    VALUES (NEW.nick, NEW.server_host, 1, NEW.ts, NEW.ts)
  ON CONFLICT(nick, server_host) DO UPDATE SET
    message_count = message_count + 1,
    last_seen_ts  = NEW.ts,
    first_seen_ts = COALESCE(first_seen_ts, NEW.ts);
END;
`

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the logger.
 *
 * @param dbPath  Path to the SQLite file. If omitted, reads LOG_DB env var.
 *                If still empty, logging is disabled (no-op).
 * @param serverHost  IRC server host to tag all records with.
 */
export function initLogger(serverHost: string, dbPath?: string): void {
  const path = dbPath ?? process.env.LOG_DB ?? ''
  _serverHost = serverHost

  if (!path) {
    // Logging disabled — that's fine
    return
  }

  try {
    mkdirSync(dirname(path), { recursive: true })
    _db = new Database(path, { create: true })
    _db.exec('PRAGMA journal_mode=WAL;')
    _db.exec('PRAGMA foreign_keys=ON;')
    _db.exec(SCHEMA)
    process.stderr.write(`smalltalk logger: logging to ${path}\n`)
  } catch (err) {
    process.stderr.write(`smalltalk logger: failed to open DB at ${path}: ${err}\n`)
    _db = null
  }
}

/**
 * Default DB path — ~/.smalltalk/messages.db
 */
export function defaultDbPath(): string {
  return join(homedir(), '.smalltalk', 'messages.db')
}

/**
 * Log a message (channel or DM).
 * No-op if logger was not initialized or init failed.
 */
export function log(msg: LogMessage): void {
  if (!_db) return
  try {
    _db.prepare(
      `INSERT INTO messages (ts, nick, target, text, kind, direction, server_host)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      msg.ts ?? new Date().toISOString(),
      msg.nick,
      msg.target,
      msg.text,
      msg.kind,
      msg.direction,
      msg.server_host ?? _serverHost,
    )
  } catch (err) {
    process.stderr.write(`smalltalk logger: write error: ${err}\n`)
  }
}

/**
 * Log a user event (join/part/quit/kick/nick_change).
 */
export function logEvent(evt: LogEvent): void {
  if (!_db) return
  try {
    _db.prepare(
      `INSERT INTO events (ts, nick, event_type, channel, detail, server_host)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      evt.ts ?? new Date().toISOString(),
      evt.nick,
      evt.event_type,
      evt.channel ?? null,
      evt.detail ?? null,
      evt.server_host ?? _serverHost,
    )
  } catch (err) {
    process.stderr.write(`smalltalk logger: event write error: ${err}\n`)
  }
}

/** Close the DB — call on shutdown. */
export function closeLogger(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

/** Exposed for testing / dashboard DB access */
export function getDb(): Database | null {
  return _db
}
