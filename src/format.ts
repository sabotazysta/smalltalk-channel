// Pure, side-effect-free helpers extracted from server.ts (2026-08-11) so they can be unit
// tested directly. server.ts itself has a top-level `await mcp.connect(transport)` — importing
// IT from a test file would try to spin up a real stdio MCP server / IRC connections, so this
// module exists specifically to hold logic that has NO business needing a live connection.

export type HistoryMessage = { ts: string; nick: string; text: string; msgid?: string }

export function getEventTs(time: Date | string | null | undefined): string {
  if (!time) return new Date().toISOString()
  if (time instanceof Date) return time.toISOString()
  if (typeof time === 'string') return time
  return new Date().toISOString()
}

// msgid is included so a message can be targeted later (e.g. by the redact tool) without a
// separate lookup — omitted from the line entirely when unavailable (older/non-tagged replay)
// rather than printing an empty "msgid=" that looks like a real-but-blank value.
export function formatHistoryMessage(m: HistoryMessage): string {
  return `[${m.ts}]${m.msgid ? ` {${m.msgid}}` : ''} <${m.nick}> ${m.text}`
}
