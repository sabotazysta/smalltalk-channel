/**
 * Cloudflare Pages Function — /api/admin/servers
 *
 * POST: creates a new server in the D1 registry, protected by ADMIN_PASS Basic Auth.
 *
 * Body: { name, tags?, websocket_url?, description? }
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

export async function onRequestPost({ request, env }) {
  const auth = checkAuth(request, env)
  if (!auth.ok) {
    if (auth.error) return new Response(auth.error, { status: 503, headers: { 'Content-Type': 'text/plain' } })
    return unauthorized()
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const { name, tags, websocket_url, id: customId } = body

  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return json({ error: 'name is required (min 2 chars)' }, 400)
  }

  // Generate ID from name, or use custom one if provided
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
  const suffix = Math.random().toString(36).slice(2, 6)
  const id = customId || `${slug}-${suffix}`

  const tagsClean = Array.isArray(tags)
    ? tags.map(t => String(t).trim()).filter(Boolean).join(',')
    : (typeof tags === 'string' ? tags.trim() : '')

  const wssUrl = (websocket_url || '').trim()

  try {
    await env.DB
      .prepare(`
        INSERT INTO servers (id, name, tags, websocket_url, contact_email, member_count, message_count, listed, created_at)
        VALUES (?, ?, ?, ?, ?, 0, 0, 1, datetime('now'))
      `)
      .bind(id, name.trim(), tagsClean, wssUrl, 'admin@smalltalk.chat')
      .run()
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      return json({ error: `Server with id "${id}" already exists` }, 409)
    }
    return json({ error: String(err) }, 500)
  }

  return json({ ok: true, id, name: name.trim() }, 201)
}
