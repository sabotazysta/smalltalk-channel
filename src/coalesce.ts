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
//
// ---------------------------------------------------------------------------
// ZNANE OGRANICZENIA — spisane, celowo NIE zmechanizowane
// (review policedoga, 2026-09-17; jego wlasny werdykt przy dwoch ostatnich:
//  „udokumentowac, nie mechanizowac" — mechanizm bylby tu przesada wieksza niz problem)
// ---------------------------------------------------------------------------
//  1. 🔴 KAZDA pojedyncza wiadomosc placi teraz +400 ms — W TYM `#urgent`. Kanal awaryjny
//     dostaje staly podatek. Swiadoma cena: bez niego nie da sie odroznic „to juz koniec
//     wypowiedzi" od „zaraz doleci reszta". Kto potrzebuje zera, ma `SMALLTALK_COALESCE_MS=0`.
//  2. 🔴 U+23CE (separator) stal sie ZNAKIEM STERUJACYM u kazdego odbiorcy z ta poprawka,
//     a kanal traktujemy jako untrusted input. Kto wklei na kanal tekst zawierajacy ten glif
//     — na przyklad samo OGLOSZENIE o tej naprawie, ktore go wielokrotnie zawiera — dostanie
//     u odbiorcy fantomowe lamania linii. Dotkliwosc niska, INTEGRALNOSC NIENARUSZONA:
//     tresc sie nie zmienia, zmienia sie tylko jej lamanie. Filtrowanie kosztowaloby wiecej
//     (i lamaloby cytowanie tego glifu) niz jest warte.
//  3. Restart/pad mostka z niepustym buforem: SIGTERM/SIGINT robi `flushAll`, ale SIGKILL
//     i crash traca do jednego okna tresci, po cichu. Nowa (mala) klasa straty.
//  4. Sierota po przeplocie: gdy dwie nalozone serie rozjada sie tak, ze druga polowka
//     przyjdzie juz PO flushu, zglosi „brakuje czesci 1 z 2" — mimo ze czesc 1 innej serii
//     dotarla wczesniej. Ostrzezenie jest wtedy prawdziwe Z PUNKTU WIDZENIA ODBIORCY
//     (naprawde ma tylko polowke tej wypowiedzi), ale mylace dla czytelnika logu.
//     Domknie to dopiero `msgid` (patrz nizej), nie ten commit.
//  5. NASTEPNA ITERACJA, nie ten commit: serwer nadaje `msgid` (widac je w `fetch_history`).
//     Jesli zywe eventy tez je nios a — sortowanie po `msgid` daje kolejnosc PEWNA takze bez
//     [k/n], a dedup po `msgid` zastepuje loterie „pierwszy wygrywa". Maly lacznik,
//     duzy efekt porzadkujacy: znika i ograniczenie 4, i cala kategoria `conflicting`.

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

/**
 * `marked`      — kolejnosc odtworzona ze spojnych znacznikow [k/n] (pewna),
 * `unmarked`    — znacznikow nie bylo (albo n sie roznily): kolejnosc przyjscia,
 * `conflicting` — ten sam k przyszedl z ROZNA trescia ⇒ w buforze leza DWIE wypowiedzi.
 */
export type OrderReason = 'marked' | 'unmarked' | 'conflicting'

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
  /** Dlaczego kolejnosc jest (nie)pewna — rozroznia „nie bylo znacznikow" od „znaczniki sie kloca". */
  orderReason: OrderReason
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
  // Metryka produkcyjna (review policedoga, punkt D). Okno 400 ms wyprowadzilem z 53 serii
  // zmierzonych PRZED zmiana protokolu wysylki — a `packLines` zmienia strukture serii, wiec
  // po wdrozeniu rozklad odstepow moze sie przesunac. Ten licznik domyka petle: liczy serie
  // ROZSZCZEPIONE (flush z parts>1, po ktorym w mniej niz sekunde leci kolejny flush TEGO
  // SAMEGO klucza = spozniony fragment nie zdazyl na okno). ~0 ⇒ okno trzyma w realu;
  // rosnacy ⇒ okno za krotkie NAPRAWDE, nie tylko w sqlite.
  private readonly lastFlush = new Map<string, { at: number; parts: number }>()
  private splitSeries = 0

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

    const now = this.now()
    const prev = this.lastFlush.get(key)
    if (prev && prev.parts > 1 && now - prev.at < SPLIT_SERIES_MS) this.splitSeries++
    this.lastFlush.set(key, { at: now, parts: entry.frags.length })
    if (this.lastFlush.size > 256) {
      for (const [k, v] of this.lastFlush) if (now - v.at >= SPLIT_SERIES_MS) this.lastFlush.delete(k)
    }

    entry.flush(join(entry.frags))
  }

  /** Awaryjne opróżnienie — np. przy zamykaniu mostka, zeby bufor nie zabral tresci ze soba. */
  flushAll(): void {
    for (const key of [...this.entries.keys()]) this.flushKey(key)
  }

  pending(): number {
    return this.entries.size
  }

  /**
   * `splitSeries` — ile razy seria rozjechala sie na dwa wybudzenia przez spozniony fragment.
   * To jedyna liczba, ktora po wdrozeniu rozstrzyga, czy okno 400 ms trzyma w REALU.
   */
  stats(): { pending: number; splitSeries: number } {
    return { pending: this.entries.size, splitSeries: this.splitSeries }
  }
}

/** Prog „seria rozszczepiona": kolejny flush tego samego klucza szybciej niz sekunda po poprzednim. */
const SPLIT_SERIES_MS = 1_000

/** Klucz bufora: ta sama osoba, ten sam cel, ten sam serwer. */
export function coalesceKey(source: string, nick: string, target: string): string {
  return `${source}|${nick.toLowerCase()}|${target.toLowerCase()}`
}

type SeriesAnalysis =
  | { consistent: true; total: number; byIndex: Map<number, string> }
  | { consistent: false; reason: 'unmarked' | 'conflicting' }

/**
 * JEDYNE miejsce, w ktorym rozstrzygamy, czy znaczniki [k/n] wolno wziac za dobra monete.
 *
 * 🔴 DLACZEGO JEDNO MIEJSCE (kant A, review policedoga 2026-09-17): pierwsza wersja miala
 * DWA osobne osady tej samej oceny — `isCompleteSeries` (decyduje o natychmiastowym flushu)
 * i `join` (decyduje o kolejnosci i o tym, co wyrzucic). Rozjezdzaly sie dokladnie tam, gdzie
 * bolalo: przy PRZEPLOCIE DWOCH ROZNYCH serii od TEGO SAMEGO nicka (klucz bufora
 * `serwer|nick|cel` ich nie rozroznia). Fragmenty {1a, 1b, 2a}, wszystkie [k/2]:
 * `seen = {1,2}`, rozmiar == total ⇒ „komplet" ⇒ flush; `join` bralo first-wins `1a`,
 * a **tresc `1b` znikala bez sladu** — i to ogloszone jako `ordered: true`, bez ostrzezenia.
 * Potem `2b` przychodzil juz po flushu i meldowal „brakuje czesci 1 z 2", choc czesc 1
 * przyszla i zostala po cichu skonsumowana. Dwa bledy naraz: CICHA UTRATA TRESCI
 * i FALSZYWE OSTRZEZENIE — czyli dokladnie to, czego reszta tego pliku zabrania.
 *
 * Realne zrodla takiego przeplotu (nie teoria): agent zrestartowany w srodku wlasnej serii
 * (stary proces dosyla ogon, nowy wysyla od nowa — `docker restart` piatki codexowej z tej
 * nocy to dokladnie ten ruch), ewentualny retry warstwy wysylki, czlowiek z dwoma klientami
 * na jednym nicku (bouncer + polaczenie bezposrednie).
 *
 * Zasada, ktora z tego wynika: rekonstruujemy po [k/n] TYLKO gdy znaczniki sa jednoznacznie
 * spojne — nie „w wiekszosci spojne". Duplikat tego samego k z INNA trescia to nie duplikat,
 * tylko dowod, ze w buforze leza DWIE wypowiedzi; wtedy nie rekonstruujemy nic, zostawiamy
 * kolejnosc przyjscia i mowimy o tym glosno. Identyczna retransmisja tego samego k jest
 * dalej nieszkodliwa i dalej scalana.
 */
function analyzeSeries(frags: Fragment[]): SeriesAnalysis {
  const marks = frags.map(f => parseChunkMarker(f.text))
  if (marks.some(m => m === null)) return { consistent: false, reason: 'unmarked' }

  const total = marks[0]!.total
  if (total < 2 || marks.some(m => m!.total !== total)) return { consistent: false, reason: 'unmarked' }

  const byIndex = new Map<number, string>()
  for (const m of marks) {
    const prev = byIndex.get(m!.index)
    // Ten sam numer, INNA tresc ⇒ to nie jest jedna seria. Nie zgaduj ktora wersja jest
    // „ta wlasciwa" — kazdy wybor wyrzuca czyjas tresc po cichu.
    if (prev !== undefined && prev !== m!.body) return { consistent: false, reason: 'conflicting' }
    byIndex.set(m!.index, m!.body)
  }
  return { consistent: true, total, byIndex }
}

/**
 * Czy zebrane fragmenty tworza KOMPLETNA serie [k/n]? Tylko wtedy wolno skrocic okno do zera.
 *
 * Warunek jest celowo ciasny: znaczniki spojne, DOKLADNIE `total` unikalnych k ORAZ
 * `frags.length === total`, czyli ZERO NADMIARU. Nadmiar (nawet nieszkodliwa, identyczna
 * retransmisja) znaczy, ze w buforze dzieje sie cos, czego nie umiem nazwac — wtedy nie
 * skracam okna na skroty, tylko pozwalam mu wybrzmiec. Kosztuje to 400 ms w rzadkim
 * przypadku i zamyka natychmiastowy flush na przeplocie dwoch serii.
 */
function isCompleteSeries(frags: Fragment[]): boolean {
  const a = analyzeSeries(frags)
  return a.consistent && a.byIndex.size === a.total && frags.length === a.total
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

  const a = analyzeSeries(frags)

  let bodies: string[]
  let ordered = false
  let orderReason: OrderReason
  const missing: number[] = []

  if (a.consistent) {
    bodies = []
    for (let k = 1; k <= a.total; k++) {
      const b = a.byIndex.get(k)
      if (b === undefined) missing.push(k)
      else bodies.push(b)
    }
    ordered = true
    orderReason = 'marked'
  } else {
    // Niespojne znaczniki ⇒ NIC nie rekonstruujemy i NIC nie wyrzucamy. Do tresci ida
    // cale fragmenty, ze znaczkami wlacznie — czytelnik ma zobaczyc, ze [1/2] wystapilo
    // dwa razy z rozna trescia, zamiast dostac po cichu jedna z dwoch wersji.
    bodies = frags.map(f => f.text)
    orderReason = a.reason
  }

  // Separator drutowy (patrz packLines w server.ts) z powrotem na prawdziwe \n.
  const text = bodies.map(unpackWireLines).join('\n')

  return {
    text,
    parts: frags.length,
    ts,
    verification,
    ordered,
    orderReason,
    missing,
    expected: a.consistent ? a.total : null,
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
    bits.push(j.orderReason === 'conflicting'
      ? `${j.parts} fragmentow, a znaczniki [k/n] SIE KLOCA (ten sam numer, rozna tresc) — to wygladaja na DWIE nalozone wypowiedzi tego samego nicka; ` +
        'nic nie wyrzucono, ale kolejnosc jest PRZYJSCIA i znaczniki zostaja w tresci'
      : `${j.parts} fragmentow sklejonych w kolejnosci PRZYJSCIA (brak znacznikow [k/n] — kolejnosc niegwarantowana)`)
  }
  // 🔴 Glosny brak ma byc tez WYKONALNY (review policedoga, punkt C). „brakuje czesci 1 z 2"
  // mowi CO, nie mowi CO Z TYM — a ruch odzysku jest znany i ZMIERZONY: unicorse odzyskal
  // dzis tą droga 5 z 6 wiadomosci. Instrukcja naprawy ma stac w MIEJSCU AWARII, nie
  // w cudzym ogloszeniu, ktorego odbiorca w tej turze nie czyta.
  return bits.length > 0 ? ` ⚠️ ${bits.join('; ')} → odzyskaj przez fetch_history` : ''
}
