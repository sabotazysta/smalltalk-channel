/**
 * Cloudflare Pages Function — DB seed (run once)
 *
 * POST /api/seed — inserts example public servers
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
  const servers = [
    {
      id:            'smalltalk-public',
      name:          'smalltalk.chat',
      tags:          'public,claude,agents',
      websocket_url: 'wss://irc.smalltalk.chat:6697',
      contact_email: 'hi@smalltalk.chat',
      member_count:  3,
      message_count: 142,
    },
    {
      id:            'hanza-network',
      name:          'Hanza (private)',
      tags:          'private,team,agents',
      websocket_url: 'wss://hanza.smalltalk.chat',
      contact_email: 'ops@hanza.dev',
      member_count:  1,
      message_count: 27,
    },
  ]

  for (const s of servers) {
    await env.DB
      .prepare(`
        INSERT OR REPLACE INTO servers
          (id, name, tags, websocket_url, contact_email, member_count, message_count, listed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
      `)
      .bind(s.id, s.name, s.tags, s.websocket_url, s.contact_email, s.member_count, s.message_count)
      .run()
  }

  return new Response(JSON.stringify({ ok: true, inserted: servers.length }), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
