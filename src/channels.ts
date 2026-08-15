/**
 * Channel-name logic, kept pure and dependency-free so it can be unit-tested.
 *
 * WHY THIS FILE EXISTS (2026-08-15, real doctor outage):
 * `joinedChannels` used to be built EXCLUSIVELY from JOIN echoes (`pool.onJoin`).
 * Ergo with `always-on` does NOT send a JOIN echo to a client that is already a
 * member of the channel — so after any process restart the set stayed empty
 * FOREVER while the agent really was on the channels. Measured on doctor:
 * `status` said `channels: none` while WHOIS numeric 319 said
 * `#public #urgent #clinic #dev @#dexter #general @#internal`; `join` refused
 * ("may need permissions"), `part` refused ("not in #general"), and — worst —
 * `handleMessage`'s "only forward from joined channels" gate silently dropped
 * every channel notification. Meanwhile `send` still worked, because it never
 * consults the set. That is the "agent floats on IRC" report: the agent
 * announcing it is disconnected while being connected.
 *
 * The fix has two halves. Persistence (joined-channels.json) restores what the
 * plugin BELIEVED. This module supports the other half: asking the SERVER what
 * it KNOWS (WHOIS self -> numeric 319) and folding all three sources together.
 *
 * server.ts cannot be imported from a test — it has a top-level
 * `await mcp.connect(transport)` — hence a separate module, same pattern as
 * format.ts.
 */

/**
 * Channel-membership status prefixes as they appear in RPL_WHOISCHANNELS (319):
 * `@` op, `+` voice, `~` founder/owner, `&` admin/protected, `%` halfop.
 * These are NOT part of the channel name.
 */
const STATUS_PREFIXES = '@+~&%'

/** IRC channel types we care about. `&` also starts a local channel name. */
export function isChannelName(name: string): boolean {
  return name.startsWith('#') || name.startsWith('&')
}

/**
 * Drop leading status prefixes: `@#dexter` -> `#dexter`, `@+#foo` -> `#foo`.
 *
 * Deliberate subtlety: `&` is ambiguous — it is both a status prefix (admin)
 * and the first character of a local channel name (`&local`). So we strip as
 * much as possible but back off until what remains still looks like a channel:
 * `@&local` -> `&local` (only the `@` was a prefix), `&local` -> `&local`
 * (nothing was a prefix), `&#ops` -> `#ops`. If no amount of stripping yields a
 * channel, the original string is handed back untouched.
 */
export function stripStatusPrefix(name: string): string {
  let max = 0
  while (max < name.length && STATUS_PREFIXES.includes(name[max])) max++
  for (let i = max; i > 0; i--) {
    const candidate = name.slice(i)
    if (isChannelName(candidate)) return candidate
  }
  return name
}

/**
 * Parse the trailing parameter of numeric 319 (RPL_WHOISCHANNELS) into clean,
 * lowercased channel names.
 *
 * Input is the raw space-separated list as it comes off the wire, e.g.
 * `"#public #urgent @#dexter +#voiced"`. irc-framework concatenates multiple
 * 319 lines into one string, so this must tolerate arbitrary whitespace.
 *
 * Returns `[]` for null/undefined/empty input — a server that sends no 319 at
 * all (agent in zero channels, or simply no reply) is a normal, non-fatal case.
 * Tokens that are not channel names after prefix-stripping are ignored rather
 * than trusted.
 */
export function parseWhoisChannels(raw: string | null | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const token of raw.split(/\s+/)) {
    if (!token) continue
    const name = stripStatusPrefix(token).toLowerCase()
    if (!isChannelName(name)) continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * Fold every membership source into one list: disk (joined-channels.json),
 * config (IRC_CHANNELS), and the server's own answer (319).
 *
 * UNION, never replace — this is the whole point. No source is authoritative
 * enough to delete another's entries: disk knows about runtime joins the server
 * might not have processed yet, 319 knows about channels the plugin never saw a
 * JOIN echo for, config knows what we are supposed to be in. A channel present
 * in only one of them must survive.
 *
 * Channel names are case-insensitive on IRC, so everything is normalised to
 * lowercase; order is first-seen, and empties are dropped.
 */
export function unionChannels(...sources: Array<Iterable<string> | null | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    if (!source) continue
    for (const raw of source) {
      if (typeof raw !== 'string') continue
      const name = stripStatusPrefix(raw.trim()).toLowerCase()
      if (!name) continue
      if (seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}
