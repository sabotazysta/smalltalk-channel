/**
 * Cloudflare Pages Function — /api/cleanup
 *
 * Removes test/duplicate server entries that have zero stats
 * and are not part of the known seed list.
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function onRequestPost({ env }) {
  const keepIds = ['smalltalk-public', 'hanza-network']

  const { results } = await env.DB
    .prepare('SELECT id, member_count, message_count FROM servers WHERE listed = 1')
    .all()

  const toDelete = (results ?? []).filter(
    s => !keepIds.includes(s.id) && (s.member_count ?? 0) === 0 && (s.message_count ?? 0) === 0
  )

  for (const s of toDelete) {
    await env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(s.id).run()
  }

  return json({ ok: true, deleted: toDelete.map(s => s.id), kept: keepIds }, 200)
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
