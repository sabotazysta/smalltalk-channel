/**
 * Cloudflare Pages Function — smalltalk-channel server registry
 *
 * GET  /api/registry — list public servers
 * POST /api/registry — register a new server
 *
 * D1 binding: DB (database_name: smalltalk-signups)
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function onRequestGet({ env }) {
  const { results } = await env.DB
    .prepare(`
      SELECT id, name, tags, websocket_url, member_count, message_count, last_heartbeat, created_at
      FROM servers
      WHERE listed = 1
      ORDER BY member_count DESC, created_at ASC
    `)
    .all()

  return json({ ok: true, servers: results ?? [] }, 200)
}

export async function onRequestPost({ request, env }) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const { name, tags, websocket_url, contact_email } = body

  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return json({ error: 'name is required (min 2 chars)' }, 400)
  }
  if (!websocket_url || typeof websocket_url !== 'string' || !websocket_url.startsWith('ws')) {
    return json({ error: 'websocket_url is required and must start with ws:// or wss://' }, 400)
  }
  if (!contact_email || typeof contact_email !== 'string' || !contact_email.includes('@')) {
    return json({ error: 'contact_email is required' }, 400)
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
  const suffix = Math.random().toString(36).slice(2, 8)
  const id = `${slug}-${suffix}`

  const tagsClean = Array.isArray(tags)
    ? tags.map(t => String(t).trim()).filter(Boolean).join(',')
    : (typeof tags === 'string' ? tags.trim() : '')

  await env.DB
    .prepare(`
      INSERT INTO servers (id, name, tags, websocket_url, contact_email, member_count, message_count, listed, created_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, 1, datetime('now'))
    `)
    .bind(id, name.trim(), tagsClean, websocket_url.trim(), contact_email.trim())
    .run()

  return json({ ok: true, id, name: name.trim() }, 201)
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
