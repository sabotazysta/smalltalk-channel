/**
 * Cloudflare Pages Function — DB migration (run once)
 *
 * POST /api/migrate — creates tables if they don't exist
 *
 * D1 binding: DB (database_name: smalltalk-signups)
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function onRequestPost({ env }) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS signups (
      email      TEXT PRIMARY KEY,
      ip         TEXT,
      created_at TEXT
    )
  `).run()

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS servers (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      tags            TEXT,
      websocket_url   TEXT NOT NULL,
      contact_email   TEXT NOT NULL,
      member_count    INTEGER DEFAULT 0,
      message_count   INTEGER DEFAULT 0,
      last_heartbeat  TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      listed          INTEGER DEFAULT 1
    )
  `).run()

  return new Response(JSON.stringify({ ok: true, message: 'Migration complete' }), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
