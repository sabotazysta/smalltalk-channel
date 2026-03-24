/**
 * Cloudflare Pages Function — server heartbeat
 *
 * POST /api/registry/:id/heartbeat
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

export async function onRequestPost({ request, env, params }) {
  const id = params.id

  let body = {}
  try {
    body = await request.json()
  } catch {
    // heartbeat body is optional
  }

  const memberCount  = Number.isInteger(body.member_count)  ? body.member_count  : null
  const messageCount = Number.isInteger(body.message_count) ? body.message_count : null

  const existing = await env.DB
    .prepare('SELECT id FROM servers WHERE id = ?')
    .bind(id)
    .first()

  if (!existing) {
    return json({ error: 'Server not found' }, 404)
  }

  if (memberCount !== null && messageCount !== null) {
    await env.DB
      .prepare(`
        UPDATE servers
        SET last_heartbeat = datetime('now'),
            member_count   = ?,
            message_count  = ?
        WHERE id = ?
      `)
      .bind(memberCount, messageCount, id)
      .run()
  } else {
    await env.DB
      .prepare(`UPDATE servers SET last_heartbeat = datetime('now') WHERE id = ?`)
      .bind(id)
      .run()
  }

  return json({ ok: true }, 200)
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
