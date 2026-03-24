/**
 * Cloudflare Pages Function — proxy to provisioning service
 *
 * POST /api/provision → proxies to https://api.smalltalk.chat/signup
 * Returns proper CORS headers so the landing page form can call it.
 *
 * GET /api/provision → proxies to https://api.smalltalk.chat/status
 */

const PROVISION_API = 'https://api.smalltalk.chat'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function onRequestGet() {
  try {
    const res = await fetch(`${PROVISION_API}/status`, { method: 'GET' })
    const data = await res.json()
    return json(data, res.status)
  } catch (err) {
    return json({ error: 'upstream_error', message: String(err) }, 502)
  }
}

export async function onRequestPost({ request }) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  try {
    const res = await fetch(`${PROVISION_API}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.email }),
    })
    const data = await res.json()
    return json(data, res.status)
  } catch (err) {
    return json({ error: 'upstream_error', message: String(err) }, 502)
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
