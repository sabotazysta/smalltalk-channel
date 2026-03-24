/**
 * Cloudflare Pages Function — /api/admin/analytics
 * Fetches real Web Analytics (RUM) data — bot-filtered page loads.
 * Required env vars: ADMIN_PASS, CF_ANALYTICS_TOKEN, CF_ACCOUNT_ID (optional)
 */
const REALM = 'smalltalk admin'
const CF_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql'
const CF_ACCOUNT_ID = '0e021abfc4b99d12f52ff0e5befe3f86'
const SITE_HOSTNAME = 'smalltalk.chat'

function unauthorized() {
  return new Response('Authentication required', { status: 401, headers: { 'WWW-Authenticate': `Basic realm="${REALM}"`, 'Content-Type': 'text/plain' } })
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}
function checkAuth(request, env) {
  const expectedPass = env.ADMIN_PASS
  if (!expectedPass) return { ok: false, error: 'ADMIN_PASS not configured' }
  const authHeader = request.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Basic ')) return { ok: false }
  let decoded
  try { decoded = atob(authHeader.slice(6)) } catch { return { ok: false } }
  const colonIdx = decoded.indexOf(':')
  const pass = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded
  if (pass !== expectedPass) return { ok: false }
  return { ok: true }
}

export async function onRequestGet({ request, env }) {
  const auth = checkAuth(request, env)
  if (!auth.ok) {
    if (auth.error) return new Response(auth.error, { status: 503 })
    return unauthorized()
  }
  const token = env.CF_ANALYTICS_TOKEN
  const accountId = env.CF_ACCOUNT_ID || CF_ACCOUNT_ID
  if (!token) return json({ error: 'CF_ANALYTICS_TOKEN not configured' }, 503)

  const now = new Date()
  const since = new Date(now); since.setDate(since.getDate() - 7)
  const sinceStr = since.toISOString().slice(0, 10)
  const untilStr = now.toISOString().slice(0, 10)

  const query = `{ viewer { accounts(filter: { accountTag: "${accountId}" }) { rumPageloadEventsAdaptiveGroups(limit: 7, orderBy: [date_ASC], filter: { AND: [{ date_geq: "${sinceStr}" }, { date_leq: "${untilStr}" }, { bot: 0 }, { requestHost: "${SITE_HOSTNAME}" }] }) { count dimensions { date } } } } }`

  try {
    const res = await fetch(CF_GRAPHQL, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) })
    const data = await res.json()
    if (data.errors) return json({ error: data.errors[0]?.message || 'GraphQL error' }, 502)
    const groups = data?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || []
    const totalViews = groups.reduce((acc, g) => acc + (g.count || 0), 0)
    return json({ ok: true, source: 'web-analytics', totals: { pageViews: totalViews }, days: groups.map(g => ({ date: g.dimensions.date, pageViews: g.count || 0 })) })
  } catch (err) {
    return json({ error: `CF API fetch failed: ${err.message}` }, 502)
  }
}
