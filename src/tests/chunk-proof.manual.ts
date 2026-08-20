import { withChunkMarkers, CHUNK_MARKER_BUDGET } from '/home/bandit/workspace/projects/smalltalk-channel/src/format'
const MAX = 400
// kopia chunkLine (server.ts nie da sie zaimportowac — top-level await mcp.connect)
function chunkLine(line: string, maxBytes: number): string[] {
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return [line]
  const chunks: string[] = []; const words = line.split(' '); let cur = ''
  const hard = (w: string) => { let b = ''; for (const ch of w) { if (Buffer.byteLength(b+ch,'utf8') > maxBytes) { if (b) chunks.push(b); b = ch } else b += ch } return b }
  for (const w of words) { const c = cur ? cur+' '+w : w
    if (Buffer.byteLength(c,'utf8') <= maxBytes) { cur = c; continue }
    if (cur) { chunks.push(cur); cur = '' }
    cur = Buffer.byteLength(w,'utf8') > maxBytes ? hard(w) : w }
  if (cur) chunks.push(cur); return chunks
}
function chunkForSend(line: string): string[] {
  const single = chunkLine(line, MAX)
  if (single.length <= 1) return single
  let parts = chunkLine(line, MAX - CHUNK_MARKER_BUDGET)
  if (parts.length > 99) parts = chunkLine(line, MAX - 11)
  return withChunkMarkers(parts)
}
const cases: [string,string][] = [
  ['krotka', 'Zielone swiatlo, robie.'],
  ['dlugi PL z ogonkami', 'Zażółć gęślą jaźń. '.repeat(70)],
  ['jedno gigantyczne slowo', 'x'.repeat(1500)],
  ['emoji na granicy', ('🔴 pomiar zamiast zalozenia ').repeat(40)],
]
let bad = 0
for (const [name, body] of cases) {
  const parts = chunkForSend(body)
  const over = parts.filter(p => Buffer.byteLength(p,'utf8') > MAX)
  const joined = parts.map(p => p.replace(/^\[\d+\/\d+\] /,'')).join(' ')
  // POPRAWKA PRZYRZADU (nie kodu): pierwsza wersja porownywala po zlaczeniu chunkow SPACJA,
  // wiec przy twardym podziale dlugiego slowa wstawiala spacje, ktorych w oryginale nie bylo,
  // i raportowala „bezstratnie:false" dla POPRAWNEGO podzialu. Wlasciwy niezmiennik: zaden
  // znak niebedacy bialym znakiem nie moze zniknac.
  const strip = (x: string) => x.replace(/\s/g, '')
  const lossless = strip(joined) === strip(body)
  const marked = parts.length === 1 || parts.every((p,i) => p.startsWith(`[${i+1}/${parts.length}] `))
  if (over.length || !lossless || !marked) bad++
  console.log(`  ${name}: czesci=${parts.length} maxB=${Math.max(...parts.map(p=>Buffer.byteLength(p,'utf8')))} <=400:${over.length===0} bezstratnie:${lossless} znaczniki:${marked}`)
}
// kontrola UJEMNA przyrzadu: celowo zle chunkowanie MUSI zostac zlapane
const badParts = withChunkMarkers(chunkLine('y'.repeat(1200), MAX))   // znacznik PO pelnym budzecie
const caught = badParts.some(p => Buffer.byteLength(p,'utf8') > MAX)
console.log(`  [kontrola ujemna] znacznik doklejony PO pelnym budzecie przekracza 400 B: ${caught} (musi byc true)`)
console.log(bad === 0 && caught ? 'WYNIK: OK' : 'WYNIK: 🔴 PROBLEM')
