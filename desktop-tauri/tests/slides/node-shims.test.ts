/**
 * The browser-build node shims (src/bridge/node-shims/) against the real Node
 * implementations they replace. vitest resolves node:crypto/node:zlib natively
 * here — the aliases only exist in vite.config.ts — so importing the shim files
 * by relative path and diffing against the genuine modules is a true check.
 *
 * The shims exist because @genoffice/pptx-engine is consumed as source and
 * references node:crypto (zip.ts originalHash, sections.ts randomUUID) and
 * node:zlib (media-insert.ts PNG IDAT).
 */
import { createHash as nodeCreateHash, randomUUID as nodeRandomUUID } from 'node:crypto'
import { deflateSync as nodeDeflate, inflateSync as nodeInflate } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { createHash, randomUUID, sha256Hex } from '../../src/bridge/node-shims/crypto'
import { deflateSync, inflateSync } from '../../src/bridge/node-shims/zlib'

describe('node-shims/crypto', () => {
  it('sha256Hex matches node:crypto', () => {
    for (const c of ['', 'abc', 'Hello PanOffice', '汉字　テスト', 'x'.repeat(100_000)]) {
      expect(sha256Hex(c)).toBe(nodeCreateHash('sha256').update(c).digest('hex'))
    }
    const bytes = new Uint8Array(4096).map((_, i) => (i * 31) % 256)
    expect(sha256Hex(bytes)).toBe(nodeCreateHash('sha256').update(bytes).digest('hex'))
  })

  it('createHash chains update() like Node (pptx-engine calls update once)', () => {
    const a = new TextEncoder().encode('part1-')
    const b = new TextEncoder().encode('part2-汉字')
    const mine = (createHash('sha256').update(a) as ReturnType<typeof createHash>)
    const ref = nodeCreateHash('sha256').update(a)
    expect(
      (mine.update(b) as ReturnType<typeof createHash>).digest('hex'),
    ).toBe((ref.update(b) as ReturnType<typeof nodeCreateHash>).digest('hex'))
  })

  it('createHash rejects unsupported algorithms loudly', () => {
    expect(() => createHash('md5')).toThrow(/sha256 only/)
  })

  it('randomUUID returns a v4 UUID', () => {
    const id = randomUUID()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(id).not.toBe(nodeRandomUUID())
  })
})

describe('node-shims/zlib (zlib RFC1950 wrapper, like Node — not raw deflate)', () => {
  const data = new TextEncoder().encode('hello deflate me 汉字 '.repeat(200))

  it('shim deflateSync decodes with node:zlib inflateSync', () => {
    const out = deflateSync(data)
    // zlib-wrapped, not raw deflate (raw would start with the deflate block directly)
    expect(out[0]).toBe(0x78)
    expect(Buffer.from(nodeInflate(Buffer.from(out))).toString('utf8')).toBe(
      new TextDecoder().decode(data),
    )
  })

  it('shim inflateSync decodes node:zlib deflateSync output', () => {
    const nodeOut = nodeDeflate(Buffer.from(data))
    expect(new TextDecoder().decode(inflateSync(new Uint8Array(nodeOut)))).toBe(
      new TextDecoder().decode(data),
    )
  })
})
