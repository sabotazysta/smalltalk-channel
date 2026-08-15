// Unit tests for the pure channel-membership logic in ../channels.
//
// These exist because of a real outage (2026-08-15, doctor): `joinedChannels` was built only from
// JOIN echoes, Ergo's always-on mode never sends a JOIN echo to an existing member, so after a
// restart the set was empty forever while the agent WAS on the channels — `status` reported
// `channels: none`, `join`/`part` refused, and channel notifications were silently dropped.
// The fix seeds the set from WHOIS numeric 319 (RPL_WHOISCHANNELS) and unions it with disk +
// config. Everything below is the logic of that fix; the IRC plumbing around it lives in
// server.ts/connection-pool.ts, which can't be imported from a test (top-level
// `await mcp.connect(transport)`).
//
// Run: bun test src/tests/channels.test.ts

import { test, expect, describe } from 'bun:test'
import { stripStatusPrefix, parseWhoisChannels, unionChannels, isChannelName } from '../channels'

describe('stripStatusPrefix', () => {
  test('strips each status prefix: @ + ~ & %', () => {
    expect(stripStatusPrefix('@#dexter')).toBe('#dexter')
    expect(stripStatusPrefix('+#voiced')).toBe('#voiced')
    expect(stripStatusPrefix('~#owned')).toBe('#owned')
    expect(stripStatusPrefix('&#admin')).toBe('#admin')
    expect(stripStatusPrefix('%#halfop')).toBe('#halfop')
  })

  test('strips stacked prefixes', () => {
    expect(stripStatusPrefix('@+#foo')).toBe('#foo')
    expect(stripStatusPrefix('~&@%+#bar')).toBe('#bar')
  })

  test('leaves an unprefixed channel untouched', () => {
    expect(stripStatusPrefix('#general')).toBe('#general')
  })

  test('does NOT eat the & of a local channel name (&local stays &local)', () => {
    // `&` is ambiguous: status prefix AND local-channel sigil. Stripping it here would
    // invent a channel called "local" that nobody is in.
    expect(stripStatusPrefix('&local')).toBe('&local')
    // ...but a status prefix in front of a local channel is still stripped:
    expect(stripStatusPrefix('@&local')).toBe('&local')
  })

  test('garbage that is not a channel at all comes back unchanged', () => {
    expect(stripStatusPrefix('@@@')).toBe('@@@')
    expect(stripStatusPrefix('')).toBe('')
  })
})

describe('parseWhoisChannels', () => {
  test('319 with prefixed and plain channels mixed — the exact doctor case', () => {
    // Verbatim from doctor's real WHOIS reply on 2026-08-15.
    const raw = '#public #urgent #clinic #dev @#dexter #general @#internal'
    expect(parseWhoisChannels(raw)).toEqual([
      '#public', '#urgent', '#clinic', '#dev', '#dexter', '#general', '#internal',
    ])
  })

  test('mixed @ and + prefixes are both normalised away', () => {
    expect(parseWhoisChannels('@#ops +#voice #plain ~#owner')).toEqual([
      '#ops', '#voice', '#plain', '#owner',
    ])
  })

  test('empty 319 -> empty list (agent in zero channels)', () => {
    expect(parseWhoisChannels('')).toEqual([])
    expect(parseWhoisChannels('   ')).toEqual([])
  })

  test('no 319 at all (null/undefined) -> empty list, never a throw', () => {
    // This is the "server did not answer / numeric never came" path. It MUST be a
    // no-op, because the caller treats an empty result as "learned nothing" and
    // leaves existing state alone.
    expect(parseWhoisChannels(null)).toEqual([])
    expect(parseWhoisChannels(undefined)).toEqual([])
  })

  test('lowercases (IRC channel names are case-insensitive) and de-duplicates', () => {
    expect(parseWhoisChannels('#General @#GENERAL #general')).toEqual(['#general'])
  })

  test('tolerates irregular whitespace (multiple 319 lines concatenated)', () => {
    expect(parseWhoisChannels('  #a   @#b \t #c  ')).toEqual(['#a', '#b', '#c'])
  })

  test('ignores tokens that are not channels after prefix-stripping', () => {
    expect(parseWhoisChannels('#real notachannel @#alsoreal')).toEqual(['#real', '#alsoreal'])
  })
})

describe('unionChannels — disk + config + 319', () => {
  const disk = ['#general', '#dev']
  const config = ['#general', '#urgent']
  const whois = parseWhoisChannels('#public #urgent #clinic #dev @#dexter #general @#internal')

  test('every channel from every source survives, duplicates collapse', () => {
    const merged = unionChannels(disk, config, whois)
    // union, so: everything, each exactly once
    expect([...merged].sort()).toEqual(
      ['#clinic', '#dev', '#dexter', '#general', '#internal', '#public', '#urgent'].sort()
    )
    expect(merged.filter((c) => c === '#general')).toHaveLength(1)
  })

  test('a channel only on disk (never in 319) survives', () => {
    // e.g. a runtime `join` the server has not reflected back yet.
    const merged = unionChannels(['#only-on-disk'], [], parseWhoisChannels('#a #b'))
    expect(merged).toContain('#only-on-disk')
    expect(merged).toContain('#a')
  })

  test('a channel only in 319 (never on disk) survives', () => {
    // The actual bug: plugin never saw the JOIN echo, so disk has no idea.
    const merged = unionChannels(['#only-on-disk'], [], parseWhoisChannels('@#only-from-server'))
    expect(merged).toContain('#only-from-server')
    expect(merged).toContain('#only-on-disk')
  })

  test('case differences across sources collapse to one lowercase entry', () => {
    expect(unionChannels(['#General'], ['#GENERAL'], ['@#general'])).toEqual(['#general'])
  })

  test('status prefixes never leak into the union', () => {
    expect(unionChannels(['@#dexter'], ['+#dev'])).toEqual(['#dexter', '#dev'])
  })

  test('empty / null / undefined sources are skipped, not fatal', () => {
    expect(unionChannels(null, undefined, [], ['#a'])).toEqual(['#a'])
    expect(unionChannels()).toEqual([])
  })

  test('accepts a Set as a source (that is how joinedChannels is stored)', () => {
    expect(unionChannels(new Set(['#a', '#b']), ['#b', '#c'])).toEqual(['#a', '#b', '#c'])
  })

  test('whitespace and empty strings are dropped rather than stored', () => {
    expect(unionChannels(['#a', '  ', '', ' #b '])).toEqual(['#a', '#b'])
  })

  test('an empty 319 result cannot erase disk or config', () => {
    // The no-answer path, at union level: nothing learned must mean nothing lost.
    expect(unionChannels(disk, config, parseWhoisChannels(null))).toEqual([
      '#general', '#dev', '#urgent',
    ])
  })
})

describe('isChannelName', () => {
  test('# and & are channels, anything else is not', () => {
    expect(isChannelName('#a')).toBe(true)
    expect(isChannelName('&a')).toBe(true)
    expect(isChannelName('a')).toBe(false)
    expect(isChannelName('')).toBe(false)
  })
})
