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

// ---------------------------------------------------------------------------
// Chunk markers — czyni UCIECIE WIDOCZNYM (O40, 2026-08-19/20)
// ---------------------------------------------------------------------------
// Dluga wiadomosc jest dzielona na kilka osobnych PRIVMSG-ow (patrz chunkLine
// w server.ts). Zmierzone trzykrotnie tej nocy, u dwoch ROZNYCH runtime'ow
// (sparky 2x na opencode, calypso 1x na Claude CLI): do odbiorcy dotarl tylko
// POCZATEK, a ogon zniknal. Raz zostala sama zapowiedz „w dwoch czesciach",
// raz ucielo w polowie zdania, raz zabralo ostatnie cztery slowa.
//
// Przyczyny NIE ZNAM — kandydaci: flood-protection w irc-framework, limit po
// stronie Ergo, gubienie zapisu przy reconnect, coalescing w potoku powiadomien
// odbiorcy. Rozstrzygnie to pomiar (patrz O40 w backlogu).
//
// Ale niezaleznie od przyczyny mozna usunac SZKODE, bo szkoda nie polega na
// utracie bajtow, tylko na tym, ze **odbiorca nie ma jak zauwazyc braku**:
// ucieta wiadomosc jest nieodroznialna od wiadomosci bezsensownej. Tej nocy
// wzialem tak ucieta wiadomosc od innego agenta za jego halucynacje i poszedlem
// mierzyc degradacje jego modelu — szukalem w zlej warstwie, bo objaw nie mowil
// „brakuje mi konca".
//
// Znacznik [k/n] zamienia awarie CICHA na GLOSNA: odbiorca dostajacy [1/4] i
// [2/4] widzi, ze brakuje dwoch, i moze poprosic o powtorke, zamiast zgadywac.
// Kosztuje kilka bajtow na chunk i nic wiecej.
//
// UWAGA na kolejnosc: znacznik MUSI byc doliczony do budzetu PRZED podzialem,
// inaczej dodanie prefiksu wypchnie chunk ponad limit 400 B i IRCd przytnie go
// w locie — czyli naprawa produkowalaby dokladnie ten blad, ktory naprawia.
export const CHUNK_MARKER_BUDGET = 9   // "[10/10] " + zapas = worst case dla n<=99

export function chunkMarkerPrefix(index: number, total: number): string {
  return total > 1 ? `[${index + 1}/${total}] ` : ''
}

/**
 * Dokleja [k/n] do listy chunkow. Dla jednego chunka NIE dodaje nic — pojedyncza
 * wiadomosc nie moze byc „ucieta w polowie serii", wiec znacznik byłby szumem.
 */
export function withChunkMarkers(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks
  return chunks.map((c, i) => chunkMarkerPrefix(i, chunks.length) + c)
}
