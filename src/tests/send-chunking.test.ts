// Testy REALNEJ sciezki wysylki: `chunkForSend` i `buildSendParts` z server.ts.
//
// Dlaczego dopiero teraz, skoro znaczniki [k/n] maja testy od O40: te funkcje byly
// NIEEKSPORTOWANE i nie mial ich kto sprawdzic. Skutek zmierzony 2026-09-04 (O238/O248):
// kalibrujac guard dlugosci wiadomosci nie mialem czym potwierdzic, ile czesci naprawde
// produkuje transport — wiec ZGADYWALEM z lektury kodu, pomylilem sie, zepsulem dzialajacy
// bezpiecznik na ~3 h i przypialem blad testem. Test tej funkcji byłby wtedy jednym poleceniem.
//
// Niezmiennik, ktory tu pilnuje (jedyny, ktory naprawde chroni odbiorce): KAZDA czesc,
// juz ZE znacznikiem, miesci sie w budzecie bajtowym. Przekroczenie = IRCd tnie w locie,
// czyli „naprawa cichego uciecia" produkuje ciche uciecie.
//
// Run: bun test src/tests/send-chunking.test.ts

import { test, expect, describe } from 'bun:test'
import { chunkLine, chunkForSend, buildSendParts, SIGNED_BODY_MAX_BYTES } from '../server'
import { CHUNK_MARKER_BUDGET } from '../format'

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
const everyPartFits = (parts: string[]) => parts.every(p => bytes(p) <= SIGNED_BODY_MAX_BYTES)

describe('niezmiennik bajtowy', () => {
  test('krotka wiadomosc: jedna czesc, zero znacznika, zero rezerwy', () => {
    const parts = chunkForSend('krotka wiadomosc')
    expect(parts).toEqual(['krotka wiadomosc'])
  })

  test('dokladnie na progu 400 B nadal jedna czesc', () => {
    const line = 'a'.repeat(SIGNED_BODY_MAX_BYTES)
    expect(bytes(line)).toBe(400)
    expect(chunkForSend(line).length).toBe(1)
  })

  test('401 B to juz dwie czesci i obie mieszcza sie ZE znacznikiem', () => {
    const line = ('slowo ').repeat(80).trim()   // ~479 B, dzieli sie na granicy slowa
    const parts = chunkForSend(line)
    expect(parts.length).toBe(2)
    expect(parts[0].startsWith('[1/2] ')).toBe(true)
    expect(everyPartFits(parts)).toBe(true)
  })

  test('768 B — przypadek, o ktory sie pomylilem w O238: DWIE czesci, nie trzy', () => {
    // Ta liczba nie jest przypadkowa: to dlugosc, dla ktorej twierdzilem (bez pomiaru),
    // ze transport daje 3 czesci. Prawdziwy transport daje 2. Wpis zostaje jako kotwica.
    const line = 'x'.repeat(768)
    const parts = chunkForSend(line)
    expect(parts.length).toBe(2)
    expect(everyPartFits(parts)).toBe(true)
  })

  test('dluga wiadomosc: kazda czesc ze znacznikiem miesci sie w budzecie', () => {
    const line = 'lorem ipsum dolor sit amet '.repeat(200)
    const parts = chunkForSend(line)
    expect(parts.length).toBeGreaterThan(2)
    expect(everyPartFits(parts)).toBe(true)
    expect(parts.every((p, i) => p.startsWith(`[${i + 1}/${parts.length}] `))).toBe(true)
  })
})

describe('rezerwa na znacznik', () => {
  test('rezerwa jest odejmowana PRZED podzialem, nie doklejana po', () => {
    // Gdyby znacznik doklejano po podziale pelnym budzetem, czesc miala by 400 + 6 B.
    const line = 'y'.repeat(500)
    const parts = chunkForSend(line)
    expect(everyPartFits(parts)).toBe(true)
    expect(bytes(parts[0])).toBeLessThanOrEqual(SIGNED_BODY_MAX_BYTES)
    expect(bytes(parts[0])).toBeGreaterThan(SIGNED_BODY_MAX_BYTES - CHUNK_MARKER_BUDGET - 2)
  })

  test('powyzej 99 czesci rezerwa rosnie do 11 i niezmiennik nadal trzyma', () => {
    // "[100/100] " ma 10 znakow — przy rezerwie 9 czesc wyszlaby ponad budzet.
    const line = 'z'.repeat(SIGNED_BODY_MAX_BYTES * 105)
    const parts = chunkForSend(line)
    expect(parts.length).toBeGreaterThan(99)
    expect(everyPartFits(parts)).toBe(true)
    const last = parts[parts.length - 1]
    expect(last.startsWith(`[${parts.length}/${parts.length}] `)).toBe(true)
  })
})

describe('UTF-8 nie jest lamany w srodku znaku', () => {
  test('polskie znaki przezywaja podzial', () => {
    const line = 'zażółć gęślą jaźń '.repeat(60)
    const parts = chunkForSend(line)
    expect(everyPartFits(parts)).toBe(true)
    // sklejenie po zdjeciu znacznikow musi odtworzyc tresc bez utraty znakow
    const joined = parts.map(p => p.replace(/^\[\d+\/\d+\] /, '')).join(' ')
    expect(joined.replace(/\s+/g, '')).toBe(line.replace(/\s+/g, ''))
  })

  test('emoji (4 bajty) nie zostaje przeciete', () => {
    const line = '🔴'.repeat(200)          // 800 B, jedno "slowo" => twardy podzial
    const parts = chunkForSend(line)
    expect(everyPartFits(parts)).toBe(true)
    expect(parts.map(p => p.replace(/^\[\d+\/\d+\] /, '')).join('')).toBe(line)
    expect(parts.join('')).not.toContain('�')
  })

  test('jedno slowo dluzsze niz budzet jest dzielone twardo, ale calo', () => {
    const word = 'ł'.repeat(500)            // 1000 B bez spacji
    const parts = chunkLine(word, SIGNED_BODY_MAX_BYTES)
    expect(parts.every(p => bytes(p) <= SIGNED_BODY_MAX_BYTES)).toBe(true)
    expect(parts.join('')).toBe(word)
  })
})

describe('buildSendParts: numeracja przez CALA serie, nie per linia (O51)', () => {
  test('kilka krotkich linii dostaje wspolna numeracje', () => {
    const parts = buildSendParts('pierwsza\ndruga\ntrzecia')
    expect(parts.length).toBe(3)
    expect(parts[0].startsWith('[1/3] ')).toBe(true)
    expect(parts[2].startsWith('[3/3] ')).toBe(true)
  })

  test('jedna linia = jedna czesc = brak znacznika', () => {
    expect(buildSendParts('tylko jedna')).toEqual(['tylko jedna'])
  })

  test('puste linie sa odsiewane, a nie wysylane jako puste PRIVMSG', () => {
    expect(buildSendParts('a\n\n\nb')).toEqual(['[1/2] a', '[2/2] b'])
  })

  test('mieszanka: dluga linia + krotka numeruje sie ciagiem przez cala serie', () => {
    const parts = buildSendParts('q'.repeat(900) + '\nkoniec')
    expect(everyPartFits(parts)).toBe(true)
    expect(parts[parts.length - 1].endsWith('koniec')).toBe(true)
    expect(parts.every((p, i) => p.startsWith(`[${i + 1}/${parts.length}] `))).toBe(true)
  })

  test('CRLF i CR traktowane jak podzial linii', () => {
    expect(buildSendParts('a\r\nb').length).toBe(2)
    expect(buildSendParts('a\rb').length).toBe(2)
  })
})

describe('kontrola negatywna: niezmiennik UMIE nie przejsc', () => {
  test('recznie zlamany budzet jest wykrywany przez ten sam pomiar', () => {
    // Gdyby everyPartFits zawsze zwracalo true, wszystkie testy wyzej nic by nie znaczyly.
    const zle = ['a'.repeat(SIGNED_BODY_MAX_BYTES + 1)]
    expect(everyPartFits(zle)).toBe(false)
  })
})
