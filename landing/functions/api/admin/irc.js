/**
 * Cloudflare Pages Function — /api/admin/irc
 *
 * Proxies requests to the admin API backend (smalltalk-admin-api).
 * Protected by the same ADMIN_PASS Basic Auth as the rest of the admin panel.
 *
 * Required env vars (CF Pages dashboard):
 *   ADMIN_PASS      — admin dashboard password
 *   ADMIN_API_URL   — base URL of the admin API, e.g. https://admin-api.smalltalk.chat
 *   ADMIN_API_TOKEN — Bearer token for the admin API
 *
 * Usage:
 *   GET /api/admin/irc?path=/channels
 *   GET /api/admin/irc?path=/channels/general/messages
 *   GET /api/admin/irc?path=/users
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

async function proxyToAdminApi(request, env, method) {
  const auth = checkAuth(request, env)
  if (!auth.ok) {
    if (auth.error) return new Response(auth.error, { status: 503, headers: { 'Content-Type': 'text/plain' } })
    return unauthorized()
  }

  if (!env.ADMIN_API_URL) {
    return json({ error: 'admin API not configured' }, 503)
  }

  const url = new URL(request.url)
  const path = url.searchParams.get('path')

  if (!path) {
    return json({ error: 'missing path query param' }, 400)
  }

  // Only allow paths starting with / and no path traversal
  if (!path.startsWith('/') || path.includes('..')) {
    return json({ error: 'invalid path' }, 400)
  }

  // Forward any extra query params (e.g. ?limit=50) except 'path' itself
  const forwardParams = new URLSearchParams()
  for (const [k, v] of url.searchParams) {
    if (k !== 'path') forwardParams.set(k, v)
  }
  const qs = forwardParams.toString()
  // Strip '#' from path segments — admin-api prepends '#' to channel names automatically
  // This avoids CF Tunnel/CDN treating %23-encoded '#' as a URL fragment
  const safePath = path.replace(/#/g, '')
  const upstreamUrl = `${env.ADMIN_API_URL.replace(/\/$/, '')}${safePath}${qs ? '?' + qs : ''}`

  const token = env.ADMIN_API_TOKEN ?? ''

  try {
    const upstream = await fetch(upstreamUrl, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    })

    const body = await upstream.text()
    return new Response(body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return json({ error: `upstream fetch failed: ${err.message}` }, 502)
  }
}

export async function onRequestGet({ request, env }) {
  return proxyToAdminApi(request, env, 'GET')
}

export async function onRequestDelete({ request, env }) {
  return proxyToAdminApi(request, env, 'DELETE')
}
