/**
 * verify.ts — hanza.sig v1 signature verification and signing for IRC messages
 *
 * IRCv3 message tags format:
 *   @+hanza.v=1;+hanza.ts=1745419200123;+hanza.kid=a7f3e2b1c4d5e6f8;+hanza.sig=<base64>
 *
 * Canonical bytes (for ed25519 verification):
 *   version (0x01) || 0x1F || ts_ms_string || 0x1F || sender || 0x1F || target || 0x1F || body
 *
 * Separator: 0x1F (Unit Separator) — non-printable, never in nicks/content.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'

export type VerificationStatus = 'verified' | 'unverified' | 'verification_failed' | 'stranger'

export interface VerificationResult {
  status: VerificationStatus
  nick?: string      // resolved from keyring
  kid?: string
  error?: string
}

const KEYRING_URL = process.env.HANZA_KEYRING_URL ?? 'http://hanza-keyring:8080'
const KEYRING_TIMEOUT_MS = parseInt(process.env.HANZA_KEYRING_TIMEOUT_MS ?? '3000', 10)

// In-memory pubkey cache: kid → pubkey Buffer (avoid repeated keyring lookups)
const pubkeyCache = new Map<string, Buffer>()

/**
 * Parse IRCv3 message tags from a raw IRC line.
 * Raw line starts with @tag1=val1;tag2=val2 COMMAND ...
 */
export function parseIrcv3Tags(rawLine: string): Map<string, string> {
  const tags = new Map<string, string>()
  if (!rawLine.startsWith('@')) return tags

  const tagsEnd = rawLine.indexOf(' ')
  if (tagsEnd === -1) return tags

  const tagStr = rawLine.slice(1, tagsEnd)
  for (const part of tagStr.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      tags.set(part, '')
    } else {
      tags.set(part.slice(0, eq), part.slice(eq + 1))
    }
  }
  return tags
}

/**
 * Build canonical bytes for ed25519 verification.
 * Format: version || SEP || ts_ms || SEP || sender || SEP || target || SEP || body
 * SEP = 0x1F (Unit Separator)
 */
export function buildCanonicalBytes(
  version: string,
  tsMs: string,
  sender: string,
  target: string,
  body: string
): Buffer {
  const SEP = Buffer.from([0x1f])
  const parts = [
    Buffer.from(version, 'utf8'),
    SEP,
    Buffer.from(tsMs, 'utf8'),
    SEP,
    Buffer.from(sender, 'utf8'),
    SEP,
    Buffer.from(target, 'utf8'),
    SEP,
    Buffer.from(body, 'utf8'),
  ]
  return Buffer.concat(parts)
}

/**
 * Fetch a public key from hanza-keyring by kid (key ID).
 * Returns null if not found (404) or error.
 * Key is cached in memory.
 */
async function fetchPublicKey(kid: string): Promise<Buffer | null> {
  if (pubkeyCache.has(kid)) return pubkeyCache.get(kid)!

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), KEYRING_TIMEOUT_MS)

    const resp = await fetch(`${KEYRING_URL}/keys/${encodeURIComponent(kid)}`, {
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (resp.status === 404) return null
    if (!resp.ok) throw new Error(`keyring HTTP ${resp.status}`)

    const data = await resp.json() as { pubkey?: string }
    if (!data.pubkey) return null

    // pubkey is "ssh-ed25519 AAAA..." or just the base64 key material
    // The keyring stores it as the full ssh public key string
    const pubkeyStr = data.pubkey.trim()
    let keyMaterial: Buffer

    if (pubkeyStr.startsWith('ssh-ed25519 ')) {
      // Parse OpenSSH public key format
      const b64 = pubkeyStr.split(' ')[1]
      const decoded = Buffer.from(b64, 'base64')
      // SSH public key wire format: len(type) + type + len(key) + key
      // Skip the key type field (4 bytes len + "ssh-ed25519" = 4+11 = 15 bytes)
      // Then read the actual key: 4 bytes len + 32 bytes key
      let offset = 0
      const typeLen = decoded.readUInt32BE(offset); offset += 4 + typeLen
      const keyLen = decoded.readUInt32BE(offset); offset += 4
      keyMaterial = decoded.slice(offset, offset + keyLen)
    } else {
      // Assume raw base64 or hex key material
      keyMaterial = Buffer.from(pubkeyStr, 'base64')
    }

    pubkeyCache.set(kid, keyMaterial)
    return keyMaterial
  } catch {
    // Cache miss errors are non-fatal — return null
    return null
  }
}

/**
 * Main verification function.
 * Takes IRCv3 tags (already parsed), sender nick, target, message body.
 */
export async function verifyMessage(
  tags: Map<string, string>,
  sender: string,
  target: string,
  body: string
): Promise<VerificationResult> {
  const version = tags.get('+hanza.v')
  const sig = tags.get('+hanza.sig')
  const kid = tags.get('+hanza.kid')
  const tsMs = tags.get('+hanza.ts')

  // No hanza tags → unverified (unsigned message, pre-flag-day normal)
  if (!version && !sig) {
    return { status: 'unverified' }
  }

  // Has some tags but missing required ones → verification_failed
  if (!version || !sig || !kid || !tsMs) {
    return { status: 'verification_failed', error: 'incomplete hanza tags', kid }
  }

  try {
    // Fetch public key for this kid
    const pubkey = await fetchPublicKey(kid)
    if (pubkey === null) {
      return { status: 'stranger', kid, error: 'kid not found in keyring' }
    }

    // Build canonical bytes
    const canonical = buildCanonicalBytes(version, tsMs, sender, target, body)

    // Decode signature from base64
    const sigBuf = Buffer.from(sig, 'base64')

    // Wrap raw 32-byte ed25519 key in SPKI DER format for node:crypto
    // SPKI DER for ed25519: OID prefix + public key
    // Full SPKI: 30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes>
    const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex')
    const spkiDer = Buffer.concat([spkiHeader, pubkey])

    const keyObj = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' })
    const valid = crypto.verify(null, canonical, keyObj, sigBuf)

    if (valid) {
      return { status: 'verified', kid }
    } else {
      return { status: 'verification_failed', kid, error: 'signature mismatch' }
    }
  } catch (err) {
    return {
      status: 'verification_failed',
      kid,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ============================================================
// SIGNING — for outgoing messages
// ============================================================

// Path to the agent's ed25519 private key (OpenSSH format, from ssh-keygen -t ed25519).
// Set via HANZA_IDENTITY_KEY_PATH env var.
// NOTE: do NOT read process.env here at module level — verify.ts is imported before
// server.ts finishes loading its .env file (ES module imports are hoisted).
// Instead, read the env var lazily inside loadIdentityKey() so it picks up the
// value after server.ts has populated process.env from ~/.claude/channels/smalltalk/.env.

let _privateKey: crypto.KeyObject | null = null
let _keyId: string | null = null

/**
 * Load (and cache) the agent's private key from disk.
 * Derives kid the same way hanza-keyring does:
 *   kid = first 16 chars of the SSH pubkey string, spaces replaced with underscores.
 *   e.g. "ssh-ed25519 AAAAC3..." → "ssh-ed25519_AAAA"
 *
 * This matches keyring/service/main.py:
 *   key_id = key_entry.get("id", pubkey[:16].replace(" ", "_"))
 */
function loadIdentityKey(): { key: crypto.KeyObject; kid: string } | null {
  if (_privateKey && _keyId) return { key: _privateKey, kid: _keyId }
  // Read lazily so we pick up the value after server.ts has loaded .env
  const IDENTITY_KEY_PATH = process.env.HANZA_IDENTITY_KEY_PATH ?? ''
  if (!IDENTITY_KEY_PATH) return null

  try {
    const keyPem = fs.readFileSync(IDENTITY_KEY_PATH, 'utf8')
    const keyObj = crypto.createPrivateKey(keyPem)

    // Derive the SSH public key base64 to reconstruct the OpenSSH pubkey string.
    // We need "ssh-ed25519 <base64>" to match what's stored in agents/*.yaml.
    const pubKey = crypto.createPublicKey(keyObj)

    // Export raw ed25519 key material (32 bytes) via JWK
    const jwk = pubKey.export({ format: 'jwk' }) as { x?: string }
    if (!jwk.x) throw new Error('could not export ed25519 public key as JWK')

    // Reconstruct OpenSSH wire format: len(type) + "ssh-ed25519" + len(key) + key
    const keyType = Buffer.from('ssh-ed25519', 'utf8')
    const keyBytes = Buffer.from(jwk.x, 'base64url')

    const typeLen = Buffer.allocUnsafe(4)
    typeLen.writeUInt32BE(keyType.length, 0)
    const keyLen = Buffer.allocUnsafe(4)
    keyLen.writeUInt32BE(keyBytes.length, 0)

    // kid = first 8 chars of base64 (standard, not url-safe) of the raw 32-byte key material.
    // This matches the keyring's agents/*.yaml id derivation:
    //   key_id = key_entry.get("id", pubkey[:16].replace(" ", "_"))
    // but since all ed25519 keys share the same "ssh-ed25519 AAAA" prefix,
    // we use the raw key bytes (unique per key) to avoid collisions.
    // e.g. muffin: UqUUOJl8, michal: DfDCGU4A
    const kid = keyBytes.toString('base64').slice(0, 8)

    _privateKey = keyObj
    _keyId = kid
    return { key: keyObj, kid }
  } catch {
    return null
  }
}

/**
 * Sign a message and return an IRCv3 tags object for use with client.say().
 * Returns null if no identity key is configured or loading fails.
 */
export function signMessage(
  senderNick: string,
  target: string,
  body: string
): Record<string, string> | null {
  const keyInfo = loadIdentityKey()
  if (!keyInfo) return null

  const version = '1'
  const tsMs = Date.now().toString()
  const canonical = buildCanonicalBytes(version, tsMs, senderNick, target, body)

  const sig = crypto.sign(null, canonical, keyInfo.key)
  const sigB64 = sig.toString('base64')

  return {
    '+hanza.v': version,
    '+hanza.ts': tsMs,
    '+hanza.kid': keyInfo.kid,
    '+hanza.sig': sigB64,
  }
}
