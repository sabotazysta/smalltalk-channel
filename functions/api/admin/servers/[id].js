/**
 * Cloudflare Pages Function — /api/admin/servers/:id
 *
 * DELETE: removes a server from the registry, protected by ADMIN_PASS Basic Auth.
 *
 * D1 binding: DB
 */

const REALM = 'smalltalk admin'

function unauthorized() {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}"`,
      'Content-Type': 'text/plain',
    },
  })
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function checkAuth(request, env) {
  const expectedPass = env.ADMIN_PASS
  if (!expectedPass) return { ok: false, error: 'ADMIN_PASS not configured' }

  const authHeader = request.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Basic ')) return { ok: false }

  let decoded
  try {
    decoded = atob(authHeader.slice(6))
  } catch {
    return { ok: false }
  }

  const colonIdx = decoded.indexOf(':')
  const pass = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded

  if (pass !== expectedPass) return { ok: false }
  return { ok: true }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 })
}

export async function onRequestPatch({ request, env, params }) {
  const auth = checkAuth(request, env)
  if (!auth.ok) {
    if (auth.error) return new Response(auth.error, { status: 503, headers: { 'Content-Type': 'text/plain' } })
    return unauthorized()
  }

  const { id } = params
  if (!id) return json({ error: 'Missing server id' }, 400)

  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { name, tags, websocket_url } = body

  // Validate provided fields
  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 2)) {
    return json({ error: 'name must be at least 2 characters' }, 400)
  }
  if (websocket_url !== undefined && (typeof websocket_url !== 'string' || !websocket_url.startsWith('ws'))) {
    return json({ error: 'websocket_url must start with ws' }, 400)
  }

  // Build dynamic UPDATE query
  const fields = []
  const values = []

  if (name !== undefined) {
    fields.push('name = ?')
    values.push(name.trim())
  }
  if (tags !== undefined) {
    fields.push('tags = ?')
    values.push(typeof tags === 'string' ? tags : JSON.stringify(tags))
  }
  if (websocket_url !== undefined) {
    fields.push('websocket_url = ?')
    values.push(websocket_url)
  }

  if (fields.length === 0) {
    return json({ error: 'No fields to update' }, 400)
  }

  values.push(id)

  const result = await env.DB
    .prepare(`UPDATE servers SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()

  if (result.changes === 0) {
    return json({ error: 'Server not found' }, 404)
  }

  const updated = {}
  if (name !== undefined) updated.name = name.trim()
  if (tags !== undefined) updated.tags = typeof tags === 'string' ? tags : JSON.stringify(tags)
  if (websocket_url !== undefined) updated.websocket_url = websocket_url

  return json({ ok: true, id, updated })
}

export async function onRequestDelete({ request, env, params }) {
  const auth = checkAuth(request, env)
  if (!auth.ok) {
    if (auth.error) return new Response(auth.error, { status: 503, headers: { 'Content-Type': 'text/plain' } })
    return unauthorized()
  }

  const { id } = params
  if (!id) return json({ error: 'Missing server id' }, 400)

  const result = await env.DB
    .prepare('DELETE FROM servers WHERE id = ?')
    .bind(id)
    .run()

  if (result.changes === 0) {
    return json({ error: 'Server not found' }, 404)
  }

  return json({ ok: true, deleted: id })
}
