/**
 * WOPI proof-key validation (MS-WOPI "proof keys"): coolwsd signs every WOPI
 * request with its RSA private key; the host fetches the matching public keys
 * from the `<proof-key>` element in /hosting/discovery and verifies
 * X-WOPI-Proof (current key) / X-WOPI-ProofOld (previous key, for rotation).
 *
 * Signed payload: uint32be(len(url)) || utf8(url.toUpperCase()) ||
 *                 uint32be(len(token)) || utf8(token) || uint64be(timestamp)
 * verified with RSASSA-PKCS1-v1_5 + SHA-256. X-WOPI-TimeStamp is a Windows
 * FILETIME (100ns ticks since 1601-01-01 UTC); we tolerate `maxSkewMs`.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto'

const FILETIME_EPOCH_OFFSET = 116_444_736_000_000_000n // 1601 -> 1970 in 100ns ticks
const CACHE_TTL_MS = 60_000

export interface ProofKeys {
  current: KeyObject
  old: KeyObject | null
}

/** Convert a Windows FILETIME timestamp to epoch milliseconds. */
export function filetimeToMs(timestamp: bigint): number {
  return Number((timestamp - FILETIME_EPOCH_OFFSET) / 10_000n)
}

/** Epoch milliseconds -> Windows FILETIME (used by tests/fake signers). */
export function msToFiletime(ms: number): bigint {
  return BigInt(ms) * 10_000n + FILETIME_EPOCH_OFFSET
}

/** Build the exact byte sequence coolwsd signs. */
export function buildProofMessage(url: string, accessToken: string, timestamp: bigint): Buffer {
  const urlBytes = Buffer.from(url.toUpperCase(), 'utf8')
  const tokenBytes = Buffer.from(accessToken, 'utf8')
  const msg = Buffer.alloc(4 + urlBytes.length + 4 + tokenBytes.length + 8)
  let off = 0
  msg.writeUInt32BE(urlBytes.length, off)
  off += 4
  urlBytes.copy(msg, off)
  off += urlBytes.length
  msg.writeUInt32BE(tokenBytes.length, off)
  off += 4
  tokenBytes.copy(msg, off)
  off += tokenBytes.length
  msg.writeBigUInt64BE(timestamp, off)
  return msg
}

/** base64 (big-endian bytes, .NET RSAParameters format) -> base64url (JWK). */
function b64ToB64Url(b64: string): string {
  return Buffer.from(b64, 'base64').toString('base64url')
}

export function keyFromModExp(modulusB64: string, exponentB64: string): KeyObject {
  return createPublicKey({
    format: 'jwk',
    key: { kty: 'RSA', n: b64ToB64Url(modulusB64), e: b64ToB64Url(exponentB64) },
  })
}

/** Extract the <proof-key .../> attributes from discovery XML, or null. */
export function parseProofKeyAttrs(xml: string): {
  modulus: string
  exponent: string
  oldmodulus?: string
  oldexponent?: string
} | null {
  const tag = /<proof-key\s+[^>]*\/?>/.exec(xml)?.[0]
  if (!tag) return null
  const attr = (name: string) => new RegExp(`${name}="([^"]+)"`).exec(tag)?.[1]
  const modulus = attr('modulus')
  const exponent = attr('exponent')
  if (!modulus || !exponent) return null
  return { modulus, exponent, oldmodulus: attr('oldmodulus'), oldexponent: attr('oldexponent') }
}

/** Fetches and caches the current+old coolwsd proof public keys. */
export class ProofKeyProvider {
  private readonly discoveryUrl: string
  private cache: { at: number; keys: ProofKeys } | null = null

  constructor(discoveryUrl: string) {
    this.discoveryUrl = discoveryUrl
  }

  async getKeys(): Promise<ProofKeys> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.keys
    try {
      const res = await fetch(this.discoveryUrl, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`discovery HTTP ${res.status}`)
      const attrs = parseProofKeyAttrs(await res.text())
      if (!attrs) throw new Error('discovery XML has no <proof-key> element')
      const keys: ProofKeys = {
        current: keyFromModExp(attrs.modulus, attrs.exponent),
        old: attrs.oldmodulus && attrs.oldexponent ? keyFromModExp(attrs.oldmodulus, attrs.oldexponent) : null,
      }
      this.cache = { at: Date.now(), keys }
      return keys
    } catch (err) {
      if (this.cache) return this.cache.keys // tolerate transient discovery outages
      throw err
    }
  }

  /** Drop the cache (used after a verification failure, in case keys rotated). */
  invalidate(): void {
    this.cache = null
  }
}

export interface ProofInput {
  /** Absolute URL as coolwsd called it (including query string). */
  url: string
  accessToken: string
  timestampHeader: string | undefined
  proofHeader: string | undefined
  proofOldHeader: string | undefined
}

export type ProofVerdict = { ok: true } | { ok: false; reason: string }

export async function validateProof(
  input: ProofInput,
  provider: ProofKeyProvider,
  maxSkewMs: number,
  now: number = Date.now(),
): Promise<ProofVerdict> {
  const { timestampHeader, proofHeader, proofOldHeader } = input
  if (!timestampHeader || (!proofHeader && !proofOldHeader)) {
    return { ok: false, reason: 'missing X-WOPI-Proof/X-WOPI-TimeStamp headers' }
  }
  let timestamp: bigint
  try {
    timestamp = BigInt(timestampHeader)
  } catch {
    return { ok: false, reason: 'malformed X-WOPI-TimeStamp' }
  }
  const skew = Math.abs(now - filetimeToMs(timestamp))
  if (skew > maxSkewMs) {
    return { ok: false, reason: `X-WOPI-TimeStamp outside ${maxSkewMs}ms window (skew ${skew}ms)` }
  }

  const msg = buildProofMessage(input.url, input.accessToken, timestamp)
  const attempt = (keys: ProofKeys): boolean => {
    if (proofHeader) {
      try {
        if (cryptoVerify('RSA-SHA256', msg, keys.current, Buffer.from(proofHeader, 'base64'))) return true
      } catch {
        // malformed signature — fall through
      }
    }
    if (proofOldHeader && keys.old) {
      try {
        if (cryptoVerify('RSA-SHA256', msg, keys.old, Buffer.from(proofOldHeader, 'base64'))) return true
      } catch {
        // malformed signature — fall through
      }
    }
    return false
  }

  let keys: ProofKeys
  try {
    keys = await provider.getKeys()
  } catch (err) {
    return { ok: false, reason: `cannot fetch proof keys: ${(err as Error).message}` }
  }
  if (attempt(keys)) return { ok: true }
  // One refetch in case coolwsd rotated keys since we cached them.
  provider.invalidate()
  try {
    keys = await provider.getKeys()
  } catch {
    return { ok: false, reason: 'proof verification failed and proof keys are unavailable' }
  }
  if (attempt(keys)) return { ok: true }
  return { ok: false, reason: 'proof signature verification failed' }
}
