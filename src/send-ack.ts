// send-ack.ts — wykrywanie ODMOWY DOSTARCZENIA po PRIVMSG (O50).
//
// Powod (zmierzone 2026-08-20 07:53): po wlaczeniu `+m` na kanalach narzedzie `send`
// zwracalo "sent to #general", a serwer wiadomosc ODRZUCAL — w historii kanalu nie bylo
// jej wcale. To proof-of-submission udajacy proof-of-delivery: agent dostaje potwierdzenie,
// probuje dalej, diagnozuje cisze i nie rozumie, dlaczego nikt nie odpowiada.
//
// IRC nie ma pozytywnego ACK dla PRIVMSG — serwer milczy przy sukcesie i odpowiada
// numerykiem przy odmowie. Wiec jedyna uczciwa konstrukcja to: wyslij, poczekaj krotka
// chwile na numeryk odmowy, i JESLI przyszedl — zglos blad zamiast sukcesu.
// Brak odmowy NIE jest dowodem dostarczenia i tak to nazywamy w komunikacie.

export type Rejection = { numeric: string; target: string; reason: string }

// Numeryki, ktore znacza "ta wiadomosc nie zostala dostarczona".
// 404 ERR_CANNOTSENDTOCHAN  — m.in. moderowany kanal (+m), zbanowany, +n bez czlonkostwa
// 401 ERR_NOSUCHNICK        — adresat nie istnieje / wylogowany
// 403 ERR_NOSUCHCHANNEL     — kanal nie istnieje
// 477 ERR_NEEDREGGEDNICK    — kanal wymaga zarejestrowanego konta
// 482 ERR_CHANOPRIVSNEEDED  — brak uprawnien (np. przy komendach kanalowych)
// 531/716 — polityki DM (Ergo: "user does not accept DMs")
const REJECTION_NUMERICS = new Set(['401', '403', '404', '477', '482', '531', '716'])

/** Parsuje surowa linie serwera. Zwraca Rejection tylko dla numerykow odmowy. */
export function parseRejection(line: string): Rejection | null {
  if (!line) return null
  // Format: [@tags] :prefix NUMERIC nick target :reason
  let rest = line.startsWith('@') ? line.slice(line.indexOf(' ') + 1) : line
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ')
    if (sp < 0) return null
    rest = rest.slice(sp + 1)
  }
  const colon = rest.indexOf(' :')
  const head = (colon >= 0 ? rest.slice(0, colon) : rest).trim().split(/\s+/)
  const reason = colon >= 0 ? rest.slice(colon + 2).trim() : ''
  const numeric = head[0]
  if (!numeric || !REJECTION_NUMERICS.has(numeric)) return null
  // head = [numeric, ourNick, target?] — target bywa nieobecny (np. 716 bez celu)
  const target = head[2] ?? ''
  return { numeric, target, reason }
}

/** Czy odmowa dotyczy tego celu? Cel IRC jest case-insensitive. */
export function rejectionMatches(rej: Rejection, target: string): boolean {
  if (!rej.target) return true          // serwer nie podal celu — przypisujemy do biezacej wysylki
  return rej.target.toLowerCase() === target.toLowerCase()
}

type RawEmitter = {
  on: (ev: string, cb: (e: { line: string; from_server: boolean }) => void) => void
  removeListener?: (ev: string, cb: (e: { line: string; from_server: boolean }) => void) => void
  off?: (ev: string, cb: (e: { line: string; from_server: boolean }) => void) => void
}

/**
 * Zbiera odmowy dla `target` od momentu wywolania. Zwraca funkcje `stop()`, ktora
 * po `graceMs` oddaje pierwsza dopasowana odmowe albo null.
 * Nasluch startuje PRZED wysylka — inaczej mozna przegapic odmowe przy szybkim serwerze
 * (lokalny Ergo odpowiada w jednostkach milisekund).
 */
export function watchForRejection(client: RawEmitter, target: string, graceMs = 400) {
  let found: Rejection | null = null
  const onRaw = (e: { line: string; from_server: boolean }) => {
    if (found || !e?.from_server) return
    const rej = parseRejection(e.line)
    if (rej && rejectionMatches(rej, target)) found = rej
  }
  client.on('raw', onRaw)
  const detach = () => {
    const rm = client.removeListener ?? client.off
    try { rm?.call(client, 'raw', onRaw) } catch { /* nieistotne */ }
  }
  return {
    /** Czeka `graceMs` (lub od razu, jesli odmowa juz jest) i zwraca wynik. */
    async settle(): Promise<Rejection | null> {
      if (!found) await new Promise(r => setTimeout(r, graceMs))
      detach()
      return found
    },
    cancel: detach,
  }
}

/** Komunikat bledu: mowi CO sie stalo i czego NIE wiemy. */
export function rejectionMessage(rej: Rejection, target: string): string {
  const hint = rej.numeric === '404'
    ? ' — kanal jest najpewniej moderowany (+m) albo nie masz prawa pisania'
    : rej.numeric === '401'
      ? ' — nie ma takiego uzytkownika (moze byc offline)'
      : ''
  return `NIE DOSTARCZONO do ${target}: serwer odrzucil (${rej.numeric} ${rej.reason})${hint}. `
    + 'Wiadomosc NIE dotarla i nie dotrze — nie ponawiaj bez zmiany uprawnien.'
}
