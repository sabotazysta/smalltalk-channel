// Unit tests for signature verification (key bound to sender nick) and [verified-operator]
// attestation in ../verify.
// Run: bun test src/tests/verify.test.ts

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import * as crypto from 'node:crypto'
import {
  verifyMessage, buildCanonicalBytes, isVerifiedOperator, parseOperatorAccounts, sameIrcName,
} from '../verify'

// ---------------------------------------------------------------------------
// Fake keyring: kid -> { nick, pubkey (OpenSSH string), status }
// ---------------------------------------------------------------------------

type Key = { kid: string; priv: crypto.KeyObject; ssh: string }

function makeKey(kid: string): Key {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const raw = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url')
  const type = Buffer.from('ssh-ed25519')
  const len = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
  const wire = Buffer.concat([len(type.length), type, len(raw.length), raw])
  return { kid, priv: privateKey, ssh: `ssh-ed25519 ${wire.toString('base64')} test` }
}

const keyring = new Map<string, Record<string, unknown>>()
const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (async (url: string | URL) => {
    const kid = decodeURIComponent(String(url).split('/keys/')[1] ?? '')
    const entry = keyring.get(kid)
    if (!entry) return new Response('{"detail":"not found"}', { status: 404 })
    return new Response(JSON.stringify(entry), { status: 200 })
  }) as typeof fetch
})
afterAll(() => { globalThis.fetch = realFetch })

let kidSeq = 0
/** Enroll a fresh key (unique kid per test — verify.ts caches by kid). */
function enroll(nick: string | undefined, status?: string): Key {
  const k = makeKey(`test${++kidSeq}`)
  const entry: Record<string, unknown> = { id: k.kid, pubkey: k.ssh }
  if (nick !== undefined) entry.nick = nick
  if (status !== undefined) entry.status = status
  keyring.set(k.kid, entry)
  return k
}

function signedTags(k: Key, sender: string, target: string, body: string): Map<string, string> {
  const ts = Date.now().toString()
  const sig = crypto.sign(null, buildCanonicalBytes('1', ts, sender, target, body), k.priv)
  return new Map([
    ['+hanza.v', '1'], ['+hanza.ts', ts], ['+hanza.kid', k.kid], ['+hanza.sig', sig.toString('base64')],
  ])
}

// ---------------------------------------------------------------------------

describe('verifyMessage — key bound to sender nick', () => {
  test('valid sig with OWN key -> verified', async () => {
    const k = enroll('muffin', 'active')
    const r = await verifyMessage(signedTags(k, 'muffin', '#dev', 'hi'), 'muffin', '#dev', 'hi')
    expect(r.status).toBe('verified')
    expect(r.nick).toBe('muffin')
  })

  test('own key, nick differs only by case -> verified', async () => {
    const k = enroll('michal', 'active')
    const r = await verifyMessage(signedTags(k, 'Michal', 'bandit', 'x'), 'Michal', 'bandit', 'x')
    expect(r.status).toBe('verified')
  })

  test('valid sig made with ANOTHER nick\'s key -> NOT verified', async () => {
    const k = enroll('muffin', 'active')
    // attacker "evil" holds muffin's key and signs canonically as itself: signature is valid
    const r = await verifyMessage(signedTags(k, 'evil', '#dev', 'hi'), 'evil', '#dev', 'hi')
    expect(r.status).toBe('verification_failed')
    expect(r.error).toContain('belongs to muffin')
  })

  test('keyring entry without nick -> not verified (fail closed)', async () => {
    const k = enroll(undefined, 'active')
    const r = await verifyMessage(signedTags(k, 'muffin', '#dev', 'hi'), 'muffin', '#dev', 'hi')
    expect(r.status).not.toBe('verified')
  })

  test('revoked key -> not verified', async () => {
    const k = enroll('muffin', 'revoked')
    const r = await verifyMessage(signedTags(k, 'muffin', '#dev', 'hi'), 'muffin', '#dev', 'hi')
    expect(r.status).toBe('verification_failed')
  })

  test('missing status is read as active (keyring default)', async () => {
    const k = enroll('muffin')
    const r = await verifyMessage(signedTags(k, 'muffin', '#dev', 'hi'), 'muffin', '#dev', 'hi')
    expect(r.status).toBe('verified')
  })

  test('tampered body -> verification_failed', async () => {
    const k = enroll('muffin', 'active')
    const r = await verifyMessage(signedTags(k, 'muffin', '#dev', 'hi'), 'muffin', '#dev', 'HI')
    expect(r.status).toBe('verification_failed')
  })

  test('unknown kid -> stranger', async () => {
    const k = makeKey('never-enrolled')
    const r = await verifyMessage(signedTags(k, 'muffin', '#dev', 'hi'), 'muffin', '#dev', 'hi')
    expect(r.status).toBe('stranger')
  })

  test('no hanza tags -> unverified', async () => {
    const r = await verifyMessage(new Map([['account', 'jedrzej']]), 'jedrzej', 'bandit', 'hi')
    expect(r.status).toBe('unverified')
  })
})

describe('isVerifiedOperator', () => {
  const ops = parseOperatorAccounts('jedrzej,gosia,Michal,michalf,balor,kacper,daniel')

  test('account tag == nick, on allowlist -> true', () => {
    expect(isVerifiedOperator({ account: 'jedrzej' }, 'jedrzej', ops)).toBe(true)
  })

  test('case-insensitive account/nick/allowlist', () => {
    expect(isVerifiedOperator({ account: 'Michal' }, 'michal', ops)).toBe(true)
    expect(isVerifiedOperator({ account: 'JEDRZEJ' }, 'Jedrzej', ops)).toBe(true)
  })

  test('no account tag -> false', () => {
    expect(isVerifiedOperator({}, 'jedrzej', ops)).toBe(false)
    expect(isVerifiedOperator(undefined, 'jedrzej', ops)).toBe(false)
    expect(isVerifiedOperator({ msgid: 'x', time: 't' }, 'jedrzej', ops)).toBe(false)
  })

  test('client-only +account tag is ignored', () => {
    expect(isVerifiedOperator({ '+account': 'jedrzej' }, 'jedrzej', ops)).toBe(false)
  })

  test('account != nick -> false (both directions)', () => {
    // allowlisted account using another nick
    expect(isVerifiedOperator({ account: 'jedrzej' }, 'evil', ops)).toBe(false)
    // non-allowlisted account using an allowlisted nick
    expect(isVerifiedOperator({ account: 'evil' }, 'jedrzej', ops)).toBe(false)
  })

  test('account not on allowlist -> false', () => {
    expect(isVerifiedOperator({ account: 'muffin' }, 'muffin', ops)).toBe(false)
  })

  test('empty / unset allowlist -> false', () => {
    expect(isVerifiedOperator({ account: 'jedrzej' }, 'jedrzej', parseOperatorAccounts(''))).toBe(false)
    expect(isVerifiedOperator({ account: 'jedrzej' }, 'jedrzej', parseOperatorAccounts(undefined))).toBe(false)
  })

  test('logged-out marker / empty account -> false', () => {
    const star = parseOperatorAccounts('*')
    expect(star.size).toBe(0)
    expect(isVerifiedOperator({ account: '*' }, '*', ops)).toBe(false)
    expect(isVerifiedOperator({ account: '' }, '', ops)).toBe(false)
  })

  test('non-ASCII look-alike that lowercases onto an allowlisted name -> false', () => {
    const kelvin = 'Kacper' // KELVIN SIGN: "K".toLowerCase() === "k"
    expect(kelvin.toLowerCase()).toBe('kacper')
    expect(isVerifiedOperator({ account: kelvin }, kelvin, ops)).toBe(false)
    expect(isVerifiedOperator({ account: kelvin }, 'kacper', ops)).toBe(false)
  })

  test('prototype keys do not count as a tag', () => {
    const tags = Object.create({ account: 'jedrzej' }) as Record<string, string>
    expect(isVerifiedOperator(tags, 'jedrzej', ops)).toBe(false)
  })
})

describe('parseOperatorAccounts / sameIrcName', () => {
  test('splits on comma and whitespace, lowercases, drops non-ASCII', () => {
    expect([...parseOperatorAccounts(' Jedrzej, gosia  michalé ,,')].sort()).toEqual(['gosia', 'jedrzej'])
  })

  test('sameIrcName rejects empty and non-ASCII', () => {
    expect(sameIrcName('a', 'A')).toBe(true)
    expect(sameIrcName('', '')).toBe(false)
    expect(sameIrcName(undefined, 'a')).toBe(false)
    expect(sameIrcName('K', 'k')).toBe(false)
  })
})
