// Testy znacznikow [k/n] (O40). Sens: ucieta wiadomosc ma byc WIDOCZNA dla odbiorcy,
// a znacznik nie moze wypchnac chunka ponad budzet bajtow — bo wtedy IRCd przytnie
// go w locie i „naprawa" wyprodukuje ten sam blad, ktory naprawia.
//
// Run: bun test src/tests/chunk-markers.test.ts

import { test, expect, describe } from 'bun:test'
import { withChunkMarkers, chunkMarkerPrefix, CHUNK_MARKER_BUDGET } from '../format'

describe('chunkMarkerPrefix', () => {
  test('pojedynczy chunk nie dostaje znacznika (nie da sie uciac serii jednoelementowej)', () => {
    expect(chunkMarkerPrefix(0, 1)).toBe('')
  })
  test('seria dostaje 1-indeksowane znaczniki', () => {
    expect(chunkMarkerPrefix(0, 3)).toBe('[1/3] ')
    expect(chunkMarkerPrefix(2, 3)).toBe('[3/3] ')
  })
})

describe('withChunkMarkers', () => {
  test('jeden chunk zostaje nietkniety', () => {
    expect(withChunkMarkers(['abc'])).toEqual(['abc'])
  })
  test('zero chunkow nie wybucha', () => {
    expect(withChunkMarkers([])).toEqual([])
  })
  test('kazdy chunk serii dostaje swoj numer i totalne n', () => {
    expect(withChunkMarkers(['a', 'b', 'c'])).toEqual(['[1/3] a', '[2/3] b', '[3/3] c'])
  })
  test('tresc chunka jest zachowana bajt w bajt po znaczniku', () => {
    const body = 'zażółć gęślą jaźń — ogonki i myślnik'
    const out = withChunkMarkers([body, 'x'])
    expect(out[0].endsWith(body)).toBe(true)
  })
  test('KLUCZOWE: znacznik + tresc nie przekracza budzetu 400 B, jesli chunkowano z rezerwa', () => {
    // symulacja realnej sciezki: dzielimy z budzetem pomniejszonym o rezerwe znacznika
    const MAX = 400
    const body = 'x'.repeat(MAX - CHUNK_MARKER_BUDGET)
    const out = withChunkMarkers([body, body])
    for (const line of out) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX)
    }
  })
  test('rezerwa wystarcza dla dwucyfrowego n (najgorszy przypadek [10/10] )', () => {
    expect(Buffer.byteLength(chunkMarkerPrefix(9, 10), 'utf8')).toBeLessThanOrEqual(CHUNK_MARKER_BUDGET)
  })
})
