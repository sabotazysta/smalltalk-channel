/**
 * Cloudflare Pages Function — smalltalk-channel signup endpoint
 *
 * Deployed automatically by Cloudflare Pages from landing/functions/api/signup.js
 * Handles POST /api/signup — stores emails in D1 database.
 *
 * D1 binding: DB (database_name: smalltalk-signups)
 * Configure in: CF Pages dashboard → Settings → Functions → D1 database bindings
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function onRequestPost({ request, env }) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const { email, honeypot } = body

  // reject bots silently — return 200 so they think it worked
  if (honeypot) return json({ ok: true }, 200)

  // validate email
  if (!email || typeof email !== 'string' || !email.includes('@') || email.length > 254) {
    return json({ error: 'Invalid email address' }, 400)
  }

  const cleanEmail = email.toLowerCase().trim()
  const ip         = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  // rate limit: max 3 signups per IP per hour
  const recentFromIp = await env.DB
    .prepare("SELECT COUNT(*) as cnt FROM signups WHERE ip = ? AND created_at > datetime('now', '-1 hour')")
    .bind(ip)
    .first()

  if (recentFromIp?.cnt >= 3) {
    return json({ error: 'Too many signups from this IP. Try again later.' }, 429)
  }

  // store — INSERT OR IGNORE so duplicates silently succeed
  await env.DB
    .prepare('INSERT OR IGNORE INTO signups (email, ip, created_at) VALUES (?, ?, datetime("now"))')
    .bind(cleanEmail, ip)
    .run()

  return json({ ok: true }, 200)
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
