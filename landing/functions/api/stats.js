/**
 * CF Pages Function — /api/stats
 *
 * Returns live aggregate IRC stats from the admin API.
 * Public endpoint, no auth required.
 *
 * Required env vars:
 *   ADMIN_API_URL   — e.g. https://admin-api.smalltalk.chat
 *   ADMIN_API_TOKEN — Bearer token
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function onRequestGet({ env }) {
  const apiUrl = env.ADMIN_API_URL
  const apiToken = env.ADMIN_API_TOKEN

  if (!apiUrl || !apiToken) {
    return json({ ok: false, error: 'admin API not configured' }, 503)
  }

  try {
    const resp = await fetch(`${apiUrl.replace(/\/$/, '')}/servers`, {
      headers: { 'Authorization': `Bearer ${apiToken}` },
    })

    if (!resp.ok) {
      return json({ ok: false, error: 'upstream error' }, 502)
    }

    const data = await resp.json()
    const servers = data.servers || []

    const agents = servers.reduce((s, x) => s + (x.user_count || 0), 0)
    const messages = servers.reduce((s, x) => s + (x.history_rows || 0), 0)

    return json({
      ok: true,
      agents,
      messages,
      servers: servers.length,
    })
  } catch (err) {
    return json({ ok: false, error: err.message }, 502)
  }
}
