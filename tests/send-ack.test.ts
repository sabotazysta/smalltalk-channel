// Test wykrywania odmowy dostarczenia (O50). Uruchom: bun test tests/send-ack.test.ts
import { parseRejection, rejectionMatches, watchForRejection, rejectionMessage } from '../src/send-ack.ts'

let pass = 0, fail = 0
const ck = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  OK   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')) }
}

console.log('=== 1. prawdziwa linia z produkcji (zmierzona dzis na Ergo) ===')
const real = ':hanza.local 404 bandit #general :Cannot send to channel (+m)'
const r1 = parseRejection(real)
ck('404 rozpoznane', r1?.numeric === '404', JSON.stringify(r1))
ck('cel wyluskany', r1?.target === '#general', JSON.stringify(r1))
ck('powod wyluskany', (r1?.reason ?? '').includes('Cannot send'), JSON.stringify(r1))
ck('dopasowanie celu bez wzgledu na wielkosc liter', !!r1 && rejectionMatches(r1, '#GENERAL'))
ck('komunikat mowi ze NIE dotarla', rejectionMessage(r1!, '#general').includes('NIE DOSTARCZONO'))
ck('komunikat podpowiada +m', rejectionMessage(r1!, '#general').includes('+m'))

console.log('=== 2. KONTROLA NEGATYWNA: zwykly ruch NIE jest odmowa ===')
for (const line of [
  ':bandit!b@h PRIVMSG #general :zwykla wiadomosc',
  ':hanza.local 353 bandit = #general :bandit doctor',
  ':hanza.local 366 bandit #general :End of NAMES list',
  ':hanza.local 324 bandit #general +imnt',
  '@time=2026-08-20T07:00:00Z :x!y@z PRIVMSG #dev :404 w tresci nie liczy sie',
  'PING :12345',
]) ck(`nie-odmowa: ${line.slice(0, 42)}…`, parseRejection(line) === null, JSON.stringify(parseRejection(line)))

console.log('=== 3. inne numeryki odmowy ===')
ck('401 (brak takiego nicka)', parseRejection(':s 401 me ghostagent :No such nick')?.numeric === '401')
ck('477 (kanal dla zarejestrowanych)', parseRejection(':s 477 me #x :Need registered nick')?.numeric === '477')
ck('linia z tagami tez parsowana', parseRejection('@time=1 :s 404 me #x :Cannot send')?.numeric === '404')

console.log('=== 4. watchForRejection: lapie odmowe wyslana PO starcie nasluchu ===')
type Cb = (e: { line: string; from_server: boolean }) => void
const mk = () => {
  const cbs: Cb[] = []
  return {
    on: (_ev: string, cb: Cb) => { cbs.push(cb) },
    removeListener: (_ev: string, cb: Cb) => { const i = cbs.indexOf(cb); if (i >= 0) cbs.splice(i, 1) },
    emit: (line: string, from_server = true) => cbs.forEach(cb => cb({ line, from_server })),
    count: () => cbs.length,
  }
}
const c1 = mk()
const w1 = watchForRejection(c1, '#general', 50)
c1.emit(real)
const got1 = await w1.settle()
ck('odmowa zlapana', got1?.numeric === '404', JSON.stringify(got1))
ck('nasluch odczepiony po settle (brak wycieku listenerow)', c1.count() === 0, String(c1.count()))

console.log('=== 5. brak odmowy => null (i to NIE jest dowod dostarczenia) ===')
const c2 = mk()
const w2 = watchForRejection(c2, '#general', 30)
c2.emit(':bandit!b@h PRIVMSG #general :cisza serwera')
ck('null gdy serwer milczy', (await w2.settle()) === null)

console.log('=== 6. odmowa dla INNEGO celu nie liczy sie ===')
const c3 = mk()
const w3 = watchForRejection(c3, '#dev', 30)
c3.emit(':hanza.local 404 bandit #general :Cannot send to channel (+m)')
ck('cel #general nie zalicza sie do wysylki na #dev', (await w3.settle()) === null)

console.log('=== 7. tylko linie OD SERWERA (from_server=false ignorowane) ===')
const c4 = mk()
const w4 = watchForRejection(c4, '#general', 30)
c4.emit(real, false)
ck('linia lokalna ignorowana', (await w4.settle()) === null)

console.log()
console.log(`PASS=${pass} FAIL=${fail}`)
if (fail) process.exit(1)
