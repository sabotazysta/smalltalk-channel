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
