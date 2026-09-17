// ---------------------------------------------------------------------------
// Sklejanie PRZYCHODZACYCH fragmentow — jedna tura na jedna WYPOWIEDZ (O-mnoznik)
// ---------------------------------------------------------------------------
// Problem, zmierzony po OBU stronach 2026-09-16/17
// (`/data/shared/dropbox/busker-socks-mnoznik-2026-09-17.md`):
//
//   26 wywolan `dm` u buskera  →  696 PRIVMSG  →  696 PELNYCH TUR u socks.
//
// Mnoznik 1 : 26,8 (mediana 27 akapitow na wiadomosc, maksimum 70). Skladaja sie na
// niego dwie rzeczy, ktore osobno wygladaja niewinnie:
//   1. NADAWCA tnie tekst po kazdej niepustej linii (`buildSendParts`) — akapit,
//      wiersz tabeli, nawet samo ``` ida jako osobny PRIVMSG (78 razy w dobe).
//   2. ODBIORCA (harness codexowy) budzi PELNA TURE na kazdy PRIVMSG.
// Jedna tura socks to ~400 tys. tokenow wejscia, a socks odpowiadala „w wiekszosci
// pusta tura, bo komplet juz odczytalam przez fetch_history" — placimy pelna stawke
// za tury, ktore nic nie wnosza.
//
// 🔴 DLACZEGO NAPRAWA JEST TUTAJ, A NIE (tylko) U NADAWCY: sufit na nadawcy skaluje
// koszt, ale go nie kasuje. Bandit ma guard ograniczajacy go do 2 czesci — zmierzone
// 2026-09-17: 13 wiadomosci → ~26 tur. Dwie czesci to nadal DWIE pelne tury. Jedyne
// miejsce, w ktorym „jedna wypowiedz = jedno wybudzenie" jest w ogole wyrazalne, to
// strona ODBIORU.
//
// MECHANIZM: fragmenty od tego samego nadawcy, do tego samego celu, buforujemy przez
// krotkie okno ciszy (debounce) i emitujemy JEDNO powiadomienie ze sklejona trescia.
//
// OKNO — Z POMIARU, NIE Z GLOWY (dane: `data/thelounge/logs/jedrzej.sqlite3`, znaczniki
// czasu w ms po stronie ODBIORU, 1327 wiadomosci, 53 serie >= 3 fragmentow):
//   • odstepy MIEDZY fragmentami jednej wysylki: p50 = 0 ms, p90 = 4 ms,
//     najgorszy zmierzony przypadek w calym zbiorze = 60 ms
//     (seria 92-fragmentowa doctora: maksymalny odstep 3 ms),
//   • struktura serii jest IDENTYCZNA przy progu sklejania 1 s i 2 s (53 serie w obu),
//     dopiero przy 5 s zaczyna scalac osobne wypowiedzi (59 serii) — czyli najkrotsza
//     zmierzona przerwa MIEDZY wypowiedziami to ~3,8 s.
//   ⇒ okno domyslne 400 ms lezy ~6,7x powyzej najgorszego odstepu WEWNATRZ serii (60 ms)
//     i ~9,5x ponizej najkrotszej przerwy MIEDZY wypowiedziami (3,8 s). Pojedyncza
//     wiadomosc jest opozniona najwyzej o te 400 ms — tyle samo, ile juz dzis kosztuje
//     `SEND_GRACE_MS` po stronie wysylki.
//
// Trzy rzeczy, ktore skracaja to okno do zera tam, gdzie da sie to zrobic bezpiecznie:
//   • KOMPLETNA seria [k/n] (mamy wszystkie n czesci) — emitujemy NATYCHMIAST,
//   • `maxWaitMs` — twardy sufit liczony od PIERWSZEGO fragmentu, zeby nadawca
//     piszacy bez przerwy nie potrafil odsunac doreczenia w nieskonczonosc,
//   • `windowMs <= 0` wylacza sklejanie calkowicie (awaryjne wyjscie przez env).
//
// KOLEJNOSC: raport odnotowal fragmenty przychodzace POZA KOLEJNOSCIA. Gdy wszystkie
// fragmenty niosa znaczniki [k/n] z tym samym n — sortujemy po k i mamy kolejnosc
// PEWNA (`ordered: true`). Gdy nie — sklejamy w kolejnosci przyjscia i `ordered: false`
// mowi wprost, ze kolejnosc NIE jest gwarantowana.
//
// BRAKI: jesli seria [k/n] jest niekompletna po uplywie okna, mowimy to GLOSNO
// (`missing`) zamiast po cichu skleic dziure. To ta sama zasada co w znacznikach [k/n]
// (O40): awaria cicha ma byc zamieniona na glosna, a nie ukryta.

import { parseChunkMarker, unpackWireLines } from './format'

export type VerificationStatus = 'verified' | 'stranger' | 'unverified' | 'verification_failed'

// Precedencja „najgorszy wygrywa". Sklejona tresc jest tak wiarygodna jak jej NAJSLABSZY
// fragment: kazdy PRIVMSG jest podpisany osobno, wiec jesli jeden nie zweryfikowal sie,
// calosci nie wolno pokazac jako [verified].
const VERIFICATION_RANK: Record<VerificationStatus, number> = {
  verification_failed: 3,
  stranger: 2,
  unverified: 1,
  verified: 0,
}

export function worstVerification(a: VerificationStatus, b: VerificationStatus): VerificationStatus {
  return VERIFICATION_RANK[a] >= VERIFICATION_RANK[b] ? a : b
}

export type Fragment = {
  text: string
  ts: string
  verification: VerificationStatus
}

export type Joined = {
  /** Sklejona tresc — znaczniki [k/n] zdjete, separator drutowy zamieniony z powrotem na \n. */
  text: string
  /** Ile PRIVMSG-ow zlozylo sie na te jedna wypowiedz (1 = nic nie sklejono). */
  parts: number
  /** Znacznik czasu PIERWSZEGO fragmentu — wypowiedz datujemy jej poczatkiem, nie koncem. */
  ts: string
  /** Najgorszy status weryfikacji sposrod fragmentow. */
  verification: VerificationStatus
  /** true = kolejnosc odtworzona ze znacznikow [k/n]; false = kolejnosc PRZYJSCIA, niegwarantowana. */
  ordered: boolean
  /** Numery (1-indeksowane) brakujacych czesci serii [k/n]. Pusta tablica = nic nie wiadomo o brakach. */
  missing: number[]
  /** n z [k/n], jesli seria byla rozpoznana. */
  expected: number | null
}

export type CoalescerOptions = {
  /** Okno ciszy. <= 0 wylacza sklejanie (kazdy fragment emitowany natychmiast). */
  windowMs?: number
  /** Twardy sufit od pierwszego fragmentu — nadawca nie moze odsuwac doreczenia w nieskonczonosc. */
  maxWaitMs?: number
  /** Bezpiecznik na patologiczna serie: po tylu fragmentach emitujemy, nie czekajac. */
  maxParts?: number
  /** Wstrzykiwalne dla testow — domyslnie globalne. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  now?: () => number
}

type Entry = {
  frags: Fragment[]
  firstAt: number
  timer: unknown
  flush: (j: Joined) => void
}

/**
 * Buforuje fragmenty per klucz (nadawca + cel + serwer) i emituje jedna sklejona
 * wypowiedz. Klucz buduje wolajacy — patrz `coalesceKey`.
 */
export class Coalescer {
  private readonly windowMs: number
  private readonly maxWaitMs: number
  private readonly maxParts: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (t: unknown) => void
  private readonly now: () => number
  private readonly entries = new Map<string, Entry>()

  constructor(opts: CoalescerOptions = {}) {
    this.windowMs = opts.windowMs ?? 400
    this.maxWaitMs = opts.maxWaitMs ?? 5_000
    this.maxParts = opts.maxParts ?? 200
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
    this.now = opts.now ?? (() => Date.now())
  }

  /**
   * Dokłada fragment do bufora. `flush` z PIERWSZEGO fragmentu jest tym, ktore
   * zostanie wywolane — routing (DM / #urgent / mention / throttle) i tak liczymy
   * raz, na CALEJ sklejonej tresci, a nie na kazdym kawalku osobno.
   */
  push(key: string, frag: Fragment, flush: (j: Joined) => void): void {
    if (this.windowMs <= 0) {
      flush(join([frag]))
      return
    }

    let entry = this.entries.get(key)
    if (!entry) {
      entry = { frags: [], firstAt: this.now(), timer: null, flush }
      this.entries.set(key, entry)
    }
    entry.frags.push(frag)

    // Komplet serii [k/n] — nie ma na co czekac, okno skraca sie do zera.
    if (isCompleteSeries(entry.frags) || entry.frags.length >= this.maxParts) {
      this.flushKey(key)
      return
    }

    if (entry.timer !== null) this.clearTimer(entry.timer)
    const elapsed = this.now() - entry.firstAt
    const delay = Math.max(0, Math.min(this.windowMs, this.maxWaitMs - elapsed))
    entry.timer = this.setTimer(() => this.flushKey(key), delay)
  }

  flushKey(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    if (entry.timer !== null) this.clearTimer(entry.timer)
    if (entry.frags.length === 0) return
    entry.flush(join(entry.frags))
  }

  /** Awaryjne opróżnienie — np. przy zamykaniu mostka, zeby bufor nie zabral tresci ze soba. */
  flushAll(): void {
    for (const key of [...this.entries.keys()]) this.flushKey(key)
  }

  pending(): number {
    return this.entries.size
  }
}

/** Klucz bufora: ta sama osoba, ten sam cel, ten sam serwer. */
export function coalesceKey(source: string, nick: string, target: string): string {
  return `${source}|${nick.toLowerCase()}|${target.toLowerCase()}`
}

/** Czy zebrane fragmenty tworza KOMPLETNA serie [k/n] (wszystkie n, to samo n, bez dziur)? */
function isCompleteSeries(frags: Fragment[]): boolean {
  const marks = frags.map(f => parseChunkMarker(f.text))
  if (marks.some(m => m === null)) return false
  const total = marks[0]!.total
  if (total < 2) return false
  if (marks.some(m => m!.total !== total)) return false
  const seen = new Set(marks.map(m => m!.index))
  return seen.size === total
}

/**
 * Skleja fragmenty w jedna wypowiedz.
 *
 * Kolejnosc: gdy KAZDY fragment ma znacznik [k/n] z tym samym n — sortujemy po k
 * (kolejnosc pewna, znaczniki zdejmujemy, bo po odtworzeniu serii sa juz szumem).
 * Gdy choc jeden nie ma znacznika albo n sie roznia — zostaje kolejnosc PRZYJSCIA
 * i `ordered: false`.
 */
export function join(frags: Fragment[]): Joined {
  const ts = frags[0]!.ts
  const verification = frags.map(f => f.verification).reduce(worstVerification, 'verified' as VerificationStatus)

  const marks = frags.map(f => parseChunkMarker(f.text))
  const allMarked = marks.every(m => m !== null)
  const total = allMarked && marks.length > 0 ? marks[0]!.total : null
  const consistent = allMarked && total !== null && total >= 2 && marks.every(m => m!.total === total)

  let bodies: string[]
  let ordered = false
  let missing: number[] = []

  if (consistent) {
    const byIndex = new Map<number, string>()
    // Duplikat tego samego k (retransmisja) nie ma nadpisywac — pierwszy wygrywa.
    frags.forEach((f, i) => {
      const k = marks[i]!.index
      if (!byIndex.has(k)) byIndex.set(k, marks[i]!.body)
    })
    bodies = []
    for (let k = 1; k <= total!; k++) {
      const b = byIndex.get(k)
      if (b === undefined) missing.push(k)
      else bodies.push(b)
    }
    ordered = true
  } else {
    bodies = frags.map(f => f.text)
  }

  // Separator drutowy (patrz packLines w server.ts) z powrotem na prawdziwe \n.
  const text = bodies.map(unpackWireLines).join('\n')

  return {
    text,
    parts: frags.length,
    ts,
    verification,
    ordered,
    missing,
    expected: consistent ? total : null,
  }
}

/**
 * Ostrzezenie doklejane do tresci, gdy sklejenie NIE jest pelnowartosciowe.
 * Zasada ta sama co przy [k/n] (O40): brak ma byc GLOSNY, nie domyslony.
 * Pusty string = nie ma o czym mowic (najczestszy przypadek).
 */
export function joinWarning(j: Joined): string {
  const bits: string[] = []
  if (j.missing.length > 0) {
    bits.push(`brakuje czesci ${j.missing.join(', ')} z ${j.expected}`)
  }
  if (!j.ordered && j.parts > 1) {
    bits.push(`${j.parts} fragmentow sklejonych w kolejnosci PRZYJSCIA (brak znacznikow [k/n] — kolejnosc niegwarantowana)`)
  }
  return bits.length > 0 ? ` ⚠️ ${bits.join('; ')}` : ''
}
