/**
 * The ported gateway's sync sha256 replaced node:crypto's createHash so the
 * save pipeline can run in the webview — pin it against the real thing.
 */
import { createHash, randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { base64ToBytes, bytesToBase64, sha256Hex } from '../../src/apps/sheets/gateway/sha256'

const nodeSha = (input: Uint8Array | string): string =>
  createHash('sha256').update(input).digest('hex')

describe('sha256Hex (pure-TS port of node:crypto sha256)', () => {
  it('matches node:crypto on strings, including multibyte UTF-8', () => {
    for (const input of ['', 'a', 'abc', 'x'.repeat(1000), '中文密码 foobar ÿ']) {
      expect(sha256Hex(input)).toBe(nodeSha(input))
    }
  })

  it('matches node:crypto on binary inputs across block boundaries', () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 128, 129, 1000, 100_000]) {
      const bytes = randomBytes(size)
      expect(sha256Hex(bytes)).toBe(nodeSha(bytes))
    }
  })

  it('base64 round-trips bytes', () => {
    const bytes = randomBytes(1024)
    expect(Buffer.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(bytes)
  })
})
