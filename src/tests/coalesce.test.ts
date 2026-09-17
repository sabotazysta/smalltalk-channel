// Testy sklejania fragmentow przychodzacych + pakowania linii na wysylce.
//
// Kotwica calego pliku to JEDNA zmierzona liczba (raport
// `/data/shared/dropbox/busker-socks-mnoznik-2026-09-17.md`): wiadomosc z 11:23,
// 4122 B w 70 niepustych liniach, dala 70 PRIVMSG-ow i 70 PELNYCH TUR u odbiorcy.
// Test roznicowy nizej odtwarza jej KSZTALT i porownuje stara sciezke z nowa.
//
// Run: bun test src/tests/coalesce.test.ts

import { test, expect, describe } from 'bun:test'
import { Coalescer, coalesceKey, join, joinWarning, worstVerification, type Fragment, type Joined } from '../coalesce'
import { buildSendParts, packLines, chunkLine, SIGNED_BODY_MAX_BYTES } from '../server'
import { WIRE_LINE_SEP, parseChunkMarker, CHUNK_MARKER_BUDGET } from '../format'

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

// Stara sciezka wysylki — WIERNA kopia `buildSendParts` sprzed poprawki (commit 9107fc5):
// kazda niepusta linia osobno, chunkowanie po bajtach, rezerwa na znacznik [k/n].
//
// ⚠️ Pierwsza wersja tego helpera POMIJALA rezerwe i przez to zaniżała liczbe czesci
// (125 zamiast 129 na jednej dlugiej linii). Zlapala to kontrola roznicowa puszczona
// przeciw PRAWDZIWEMU staremu kodowi z gita — nie lektura. Stad ten ksztalt: helper,
// ktory ma udawac stary kod, musi sie z nim zgadzac co do liczby na KAZDYM wejsciu,
// nie tylko na tym jednym, o ktore mi chodzilo.
function legacySendParts(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.length > 0)
  const split = (reserve: number) => lines.flatMap(l => chunkLine(l, SIGNED_BODY_MAX_BYTES - reserve))
  const bare = split(0)
  if (bare.length <= 1) return bare
  let parts = split(CHUNK_MARKER_BUDGET)
  if (parts.length > 99) parts = split(11)
  return parts.map((c, i) => `[${i + 1}/${parts.length}] ` + c)
}

// Zegar sterowany recznie — bez niego test debounce'u musialby naprawde spac.
function fakeClock() {
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    opts: {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
      clearTimer: (t: unknown) => { timers.delete(t as number) },
    },
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = target
    },
  }
}

const frag = (text: string, ts = '2026-09-17T10:00:00.000Z'): Fragment =>
  ({ text, ts, verification: 'verified' })

// Wiadomosc o KSZTALCIE tej z 11:23: 70 niepustych linii, ~4122 B.
function realShapedMessage(): string {
  const lines: string[] = []
  for (let i = 1; i <= 70; i++) {
    // srednia linia w zmierzonej wiadomosci miala ~59 B (4122/70)
    lines.push(i % 9 === 0 ? '```' : `akapit numer ${i} — ${'x'.repeat(40)}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
describe('TEST ROZNICOWY — realny przypadek z 11:23 (4122 B / 70 linii)', () => {
  const text = realShapedMessage()

  test('ksztalt wejscia zgadza sie z pomiarem: 70 niepustych linii, ~4 kB', () => {
    expect(text.split('\n').filter(l => l.length > 0).length).toBe(70)
    expect(bytes(text)).toBeGreaterThan(3500)
    expect(bytes(text)).toBeLessThan(4600)
  })

  test('STARA sciezka: 70 PRIVMSG = 70 wybudzen odbiorcy', () => {
    expect(legacySendParts(text).length).toBe(70)
  })

  test('NOWA sciezka, obie warstwy razem: 70 wybudzen → 1', () => {
    const parts = buildSendParts(text)                  // warstwa 2: pakowanie linii
    expect(parts.length).toBeLessThanOrEqual(13)        // ~4122 B / 400 B budzetu

    const clock = fakeClock()
    const c = new Coalescer({ windowMs: 400, maxWaitMs: 5_000, ...clock.opts })
    const wakeups: Joined[] = []
    for (const p of parts) c.push('k', frag(p), j => wakeups.push(j))
    clock.advance(1_000)

    expect(wakeups.length).toBe(1)                      // warstwa 1: jedno wybudzenie
    expect(wakeups[0]!.parts).toBe(parts.length)
  })

  test('sama warstwa 1 (nadawca BEZ poprawki) tez daje 1 wybudzenie z 70 fragmentow', () => {
    const clock = fakeClock()
    const c = new Coalescer({ windowMs: 400, maxWaitMs: 5_000, maxParts: 500, ...clock.opts })
    const wakeups: Joined[] = []
    for (const p of legacySendParts(text)) c.push('k', frag(p), j => wakeups.push(j))
    clock.advance(1_000)
    expect(wakeups.length).toBe(1)
    expect(wakeups[0]!.parts).toBe(70)
  })
})

// ---------------------------------------------------------------------------
describe('nic nie ginie', () => {
  test('round-trip: tekst → buildSendParts → sklejenie == tekst wejsciowy', () => {
    const text = realShapedMessage()
    const parts = buildSendParts(text)
    const joined = join(parts.map(p => frag(p)))
    expect(joined.text).toBe(text)
    expect(joined.missing).toEqual([])
  })

  test('round-trip dziala takze dla fragmentow POZA KOLEJNOSCIA (znaczniki [k/n])', () => {
    const text = realShapedMessage()
    const parts = buildSendParts(text)
    expect(parts.length).toBeGreaterThan(1)
    const shuffled = [...parts].reverse()
    const joined = join(shuffled.map(p => frag(p)))
    expect(joined.ordered).toBe(true)
    expect(joined.text).toBe(text)
  })

  test('bez znacznikow [k/n]: sklejamy w kolejnosci PRZYJSCIA i mowimy, ze nie jest gwarantowana', () => {
    const joined = join([frag('druga'), frag('pierwsza')])
    expect(joined.ordered).toBe(false)
    expect(joined.text).toBe('druga\npierwsza')
    expect(joinWarning(joined)).toContain('kolejnosci PRZYJSCIA')
  })

  test('brak czesci serii jest GLOSNY, nie zaklejony po cichu', () => {
    const joined = join([frag('[1/3] a'), frag('[3/3] c')])
    expect(joined.missing).toEqual([2])
    expect(joined.text).toBe('a\nc')
    expect(joinWarning(joined)).toContain('brakuje czesci 2 z 3')
  })

  test('duplikat tego samego [k/n] nie mnozy tresci', () => {
    const joined = join([frag('[1/2] a'), frag('[1/2] a'), frag('[2/2] b')])
    expect(joined.text).toBe('a\nb')
    expect(joined.missing).toEqual([])
  })
})

// ---------------------------------------------------------------------------
describe('pilnosc — sklejanie nie moze wydluzyc sciezki wiadomosci', () => {
  test('pojedyncza wiadomosc budzi RAZ i czeka dokladnie okno, nie dluzej', () => {
    const clock = fakeClock()
    const c = new Coalescer({ windowMs: 400, maxWaitMs: 5_000, ...clock.opts })
    const wakeups: Joined[] = []
    c.push('k', frag('pilne'), j => wakeups.push(j))

    clock.advance(399)
    expect(wakeups.length).toBe(0)     // jeszcze w oknie
    clock.advance(1)
    expect(wakeups.length).toBe(1)     // dokladnie na oknie
    expect(wakeups[0]!.text).toBe('pilne')
    expect(wakeups[0]!.parts).toBe(1)
  })

  test('KOMPLETNA seria [k/n] leci natychmiast — okno skraca sie do zera', () => {
    const clock = fakeClock()
    const c = new Coalescer({ windowMs: 400, maxWaitMs: 5_000, ...clock.opts })
    const wakeups: Joined[] = []
    c.push('k', frag('[1/2] a'), j => wakeups.push(j))
    expect(wakeups.length).toBe(0)
    c.push('k', frag('[2/2] b'), j => wakeups.push(j))
    expect(wakeups.length).toBe(1)     // bez advance — zero czekania
    expect(wakeups[0]!.text).toBe('a\nb')
  })

  test('nadawca piszacy bez przerwy nie odsunie doreczenia poza maxWaitMs', () => {
    const clock = fakeClock()
    const c = new Coalescer({ windowMs: 400, maxWaitMs: 1_000, ...clock.opts })
    const wakeups: Joined[] = []
    for (let i = 0; i < 20; i++) {
      c.push('k', frag(`f${i}`), j => wakeups.push(j))
      clock.advance(300)               // ciagle ponizej okna — debounce sam nigdy nie wygasnie
    }
    expect(wakeups.length).toBeGreaterThan(0)
    expect(wakeups[0]!.parts).toBeLessThanOrEqual(5)   // ~1000 ms / 300 ms
  })

  test('windowMs <= 0 wylacza sklejanie calkowicie (awaryjne wyjscie)', () => {
    const c = new Coalescer({ windowMs: 0 })
    const wakeups: Joined[] = []
    c.push('k', frag('a'), j => wakeups.push(j))
    c.push('k', frag('b'), j => wakeups.push(j))
    expect(wakeups.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
describe('rozdzielanie wypowiedzi', () => {
  test('dwie ROZNE wypowiedzi rozdzielone przerwa daja DWA wybudzenia', () => {
    const clock = fakeClock()
    const c = new Coalescer({ windowMs: 400, maxWaitMs: 5_000, ...clock.opts })
    const wakeups: Joined[] = []
    c.push('k', frag('pierwsza wypowiedz'), j => wakeups.push(j))
    clock.advance(3_800)               // najkrotsza ZMIERZONA przerwa miedzy wypowiedziami
    c.push('k', frag('druga wypowiedz'), j => wakeups.push(j))
    clock.advance(1_000)
    expect(wakeups.length).toBe(2)
    expect(wakeups[0]!.text).toBe('pierwsza wypowiedz')
    expect(wakeups[1]!.text).toBe('druga wypowiedz')
  })

  test('DWAJ nadawcy w tym samym oknie nie mieszaja sie ze soba', () => {
    const clock = fakeClock()
    const c = new Coalescer({ windowMs: 400, maxWaitMs: 5_000, ...clock.opts })
    const wakeups: Joined[] = []
    const kA = coalesceKey('hanza', 'busker', '#dev')
    const kB = coalesceKey('hanza', 'socks', '#dev')
    c.push(kA, frag('a1'), j => wakeups.push(j))
    c.push(kB, frag('b1'), j => wakeups.push(j))
    c.push(kA, frag('a2'), j => wakeups.push(j))
    clock.advance(1_000)
    expect(wakeups.length).toBe(2)
    expect(wakeups.map(w => w.text).sort()).toEqual(['a1\na2', 'b1'])
  })

  test('ten sam nadawca w DM i na kanale to dwa osobne bufory', () => {
    expect(coalesceKey('h', 'busker', '#dev')).not.toBe(coalesceKey('h', 'busker', 'bandit'))
  })

  test('flushAll oddaje to, co bufor trzyma (zamykanie mostka)', () => {
    const clock = fakeClock()
    const c = new Coalescer({ windowMs: 400, maxWaitMs: 5_000, ...clock.opts })
    const wakeups: Joined[] = []
    c.push('k', frag('niedokonczone'), j => wakeups.push(j))
    expect(c.pending()).toBe(1)
    c.flushAll()
    expect(wakeups.length).toBe(1)
    expect(c.pending()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
describe('weryfikacja podpisu — najgorszy fragment decyduje o calosci', () => {
  test('jeden niezweryfikowany fragment psuje status calej sklejonej tresci', () => {
    const j = join([
      { text: '[1/2] a', ts: 't', verification: 'verified' },
      { text: '[2/2] b', ts: 't', verification: 'verification_failed' },
    ])
    expect(j.verification).toBe('verification_failed')
  })
  test('precedencja: failed > stranger > unverified > verified', () => {
    expect(worstVerification('verified', 'unverified')).toBe('unverified')
    expect(worstVerification('unverified', 'stranger')).toBe('stranger')
    expect(worstVerification('stranger', 'verification_failed')).toBe('verification_failed')
  })
  test('sklejona wypowiedz datowana jest PIERWSZYM fragmentem', () => {
    const j = join([frag('a', '2026-09-17T10:00:00.000Z'), frag('b', '2026-09-17T10:00:05.000Z')])
    expect(j.ts).toBe('2026-09-17T10:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
describe('warstwa 2 — pakowanie linii na wysylce', () => {
  test('krotkie linie ida razem, nie kazda osobno', () => {
    const parts = packLines(['a', 'b', 'c'], SIGNED_BODY_MAX_BYTES)
    expect(parts).toEqual([`a${WIRE_LINE_SEP}b${WIRE_LINE_SEP}c`])
  })

  test('niezmiennik bajtowy trzyma — kazda czesc ZE znacznikiem miesci sie w budzecie', () => {
    const parts = buildSendParts(realShapedMessage())
    expect(parts.every(p => bytes(p) <= SIGNED_BODY_MAX_BYTES)).toBe(true)
    expect(parts.every((p, i) => p.startsWith(`[${i + 1}/${parts.length}] `))).toBe(true)
  })

  test('linia DLUZSZA niz budzet nie jest pakowana z sasiadami (nie zmyslamy lamania)', () => {
    const long = 'x'.repeat(SIGNED_BODY_MAX_BYTES + 50)
    const parts = packLines(['krotka', long, 'kolejna'], SIGNED_BODY_MAX_BYTES)
    expect(parts[0]).toBe('krotka')
    expect(parts.some(p => p.includes(WIRE_LINE_SEP) && p.includes('x'))).toBe(false)
    expect(parts[parts.length - 1]).toBe('kolejna')
  })

  test('pojedyncza krotka wiadomosc dalej jest jedna czescia bez znacznika', () => {
    expect(buildSendParts('krotka')).toEqual(['krotka'])
  })

  test('parseChunkMarker jest odwrotnoscia chunkMarkerPrefix', () => {
    const m = parseChunkMarker('[3/12] tresc')
    expect(m).toEqual({ index: 3, total: 12, body: 'tresc' })
    expect(parseChunkMarker('zwykly tekst')).toBeNull()
    expect(parseChunkMarker('[5/2] bzdura')).toBeNull()   // k > n
  })

  test('rezerwa CHUNK_MARKER_BUDGET jest nadal respektowana po spakowaniu', () => {
    const many = Array.from({ length: 300 }, (_, i) => `linia ${i}`).join('\n')
    const parts = buildSendParts(many)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every(p => bytes(p) <= SIGNED_BODY_MAX_BYTES)).toBe(true)
    expect(CHUNK_MARKER_BUDGET).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
describe('zmierzone straty — spisane jawnie, nie ukryte', () => {
  test('puste linie gina — tak jak ginely PRZED poprawka (bez regresji)', () => {
    const text = 'a\n\n\nb'
    expect(buildSendParts(text)).toEqual([`a${WIRE_LINE_SEP}b`])
    expect(legacySendParts(text)).toEqual(['[1/2] a', '[2/2] b'])   // stary kod: dwa PRIVMSG, dwa wybudzenia
  })

  test('linia dluzsza niz budzet po sklejeniu dostaje lamanie, ktorego nie bylo', () => {
    // Znane ograniczenie: `chunkLine` tnie w srodku linii, a odbiorca nie ma jak
    // odroznic „tu bylo \n" od „tu bylo miekkie zawiniecie". Zapisuje to testem,
    // zeby nie udawac, ze round-trip jest zawsze dokladny.
    const long = 'slowo '.repeat(100).trim()
    const joined = join(buildSendParts(long).map(p => frag(p)))
    expect(joined.text).not.toBe(long)
    expect(joined.text.replace(/\n/g, ' ')).toBe(long)
  })
})
