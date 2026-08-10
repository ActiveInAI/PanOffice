import { afterAll, describe, expect, it } from 'vitest'
import { buildProofMessage, filetimeToMs, msToFiletime, parseProofKeyAttrs } from '../src/proof.js'
import {
  discoveryXmlWithProofKeys,
  generateProofKeys,
  proofHeaders,
  signWopiProof,
  startFakeDiscovery,
  startTestServer,
} from './helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()))
})

describe('proof primitives (unit)', () => {
  it('buildProofMessage lays out len32(url) ‖ url ‖ len32(token) ‖ token ‖ u64be(ts)', () => {
    const ts = 133_000_000_000_000_000n
    const msg = buildProofMessage('HTTP://X/WOPI', 'tok', ts)
    const urlBytes = Buffer.from('HTTP://X/WOPI', 'utf8')
    expect(msg.readUInt32BE(0)).toBe(urlBytes.length)
    expect(msg.subarray(4, 4 + urlBytes.length).toString('utf8')).toBe('HTTP://X/WOPI')
    const tokenOff = 4 + urlBytes.length
    expect(msg.readUInt32BE(tokenOff)).toBe(3)
    expect(msg.subarray(tokenOff + 4, tokenOff + 7).toString('utf8')).toBe('tok')
    expect(msg.readBigUInt64BE(tokenOff + 7)).toBe(ts)
  })

  it('uppercases the URL but not the token', () => {
    const msg = buildProofMessage('http://host/wopi/files/A.docx?access_token=AbC', 'AbC', 1n)
    expect(msg.toString('utf8', 4)).toContain('HTTP://HOST/WOPI/FILES/A.DOCX?ACCESS_TOKEN=ABC')
    expect(msg.toString('utf8')).toContain('AbC')
  })

  it('FILETIME round-trips through ms', () => {
    const now = 1_757_500_000_000
    expect(filetimeToMs(msToFiletime(now))).toBe(now)
    // sanity: 1970-01-01 is FILETIME 116444736000000000
    expect(msToFiletime(0)).toBe(116_444_736_000_000_000n)
  })

  it('parses <proof-key> attributes incl. rotation pair', () => {
    const xml =
      '<wopi-discovery><proof-key modulus="bW9k" exponent="ZXhw" oldmodulus="b2xkbW9k" oldexponent="b2xkZXhw"/></wopi-discovery>'
    expect(parseProofKeyAttrs(xml)).toEqual({
      modulus: 'bW9k',
      exponent: 'ZXhw',
      oldmodulus: 'b2xkbW9k',
      oldexponent: 'b2xkZXhw',
    })
    expect(parseProofKeyAttrs('<wopi-discovery/>')).toBeNull()
  })
})

describe('proof validation (HTTP, WOPI_PROOF_REQUIRED=true)', () => {
  async function setup(withOld = false) {
    const keys = generateProofKeys(withOld)
    const discovery = await startFakeDiscovery(discoveryXmlWithProofKeys(keys))
    cleanups.push(discovery.close)
    const srv = await startTestServer({
      proofRequired: true,
      collaboraInternalUrl: discovery.url,
    })
    cleanups.push(srv.close)
    return { keys, srv }
  }

  /** The URL the app reconstructs: wopiPublicBase + path-and-query. */
  function signedUrl(srv: { cfg: { wopiPublicBase: string } }, path: string, token = 'devtoken'): string {
    return `${srv.cfg.wopiPublicBase}${path}?access_token=${token}`
  }

  async function getWithProof(
    srv: { base: string; cfg: { wopiPublicBase: string } },
    headers: Record<string, string>,
    token = 'devtoken',
  ): Promise<Response> {
    return fetch(`${srv.base}/wopi/files/a.docx?access_token=${token}`, { headers })
  }

  it('accepts a correctly signed request', async () => {
    const { keys, srv } = await setup()
    const url = signedUrl(srv, '/wopi/files/a.docx')
    const res = await getWithProof(srv, proofHeaders(keys.current.privateKey, url, 'devtoken'))
    expect(res.status).toBe(200)
  })

  it('rejects a tampered signature with 401', async () => {
    const { keys, srv } = await setup()
    const url = signedUrl(srv, '/wopi/files/a.docx')
    const headers = proofHeaders(keys.current.privateKey, url, 'devtoken')
    const raw = Buffer.from(headers['X-WOPI-Proof'], 'base64')
    raw[10] = raw[10] ^ 0xff
    headers['X-WOPI-Proof'] = raw.toString('base64')
    const res = await getWithProof(srv, headers)
    expect(res.status).toBe(401)
    expect(await res.text()).toContain('proof')
  })

  it('rejects a signature computed over a different URL', async () => {
    const { keys, srv } = await setup()
    const headers = proofHeaders(keys.current.privateKey, 'http://wopi.test/wopi/files/other.docx?access_token=devtoken', 'devtoken')
    const res = await getWithProof(srv, headers)
    expect(res.status).toBe(401)
  })

  it('rejects a signature from an unrelated key', async () => {
    const { srv } = await setup()
    const rogue = generateProofKeys()
    const url = signedUrl(srv, '/wopi/files/a.docx')
    const res = await getWithProof(srv, proofHeaders(rogue.current.privateKey, url, 'devtoken'))
    expect(res.status).toBe(401)
  })

  it('rejects a stale X-WOPI-TimeStamp (outside the 10 min window)', async () => {
    const { keys, srv } = await setup()
    const url = signedUrl(srv, '/wopi/files/a.docx')
    const twentyMinAgo = Date.now() - 20 * 60 * 1000
    const res = await getWithProof(srv, proofHeaders(keys.current.privateKey, url, 'devtoken', twentyMinAgo))
    expect(res.status).toBe(401)
  })

  it('accepts a timestamp inside the skew window', async () => {
    const { keys, srv } = await setup()
    const url = signedUrl(srv, '/wopi/files/a.docx')
    const nineMinAgo = Date.now() - 9 * 60 * 1000
    const res = await getWithProof(srv, proofHeaders(keys.current.privateKey, url, 'devtoken', nineMinAgo))
    expect(res.status).toBe(200)
  })

  it('rejects requests with missing proof headers', async () => {
    const { srv } = await setup()
    expect((await getWithProof(srv, {})).status).toBe(401)
    const keys = generateProofKeys()
    const url = signedUrl(srv, '/wopi/files/a.docx')
    const onlySig = { 'X-WOPI-Proof': signWopiProof(keys.current.privateKey, url, 'devtoken', msToFiletime(Date.now())) }
    expect((await getWithProof(srv, onlySig)).status).toBe(401)
  })

  it('accepts X-WOPI-ProofOld signed by the rotated-out key', async () => {
    const { keys, srv } = await setup(true)
    const url = signedUrl(srv, '/wopi/files/a.docx')
    // client still signs with the OLD private key, sent as X-WOPI-ProofOld
    const headers = proofHeaders(keys.old!.privateKey, url, 'devtoken', Date.now(), 'X-WOPI-ProofOld')
    const res = await getWithProof(srv, headers)
    expect(res.status).toBe(200)
  })

  it('rejects X-WOPI-ProofOld signed by an unrelated key', async () => {
    const { srv } = await setup(true)
    const rogue = generateProofKeys()
    const url = signedUrl(srv, '/wopi/files/a.docx')
    const headers = proofHeaders(rogue.current.privateKey, url, 'devtoken', Date.now(), 'X-WOPI-ProofOld')
    const res = await getWithProof(srv, headers)
    expect(res.status).toBe(401)
  })

  it('fails closed (401) when discovery has no <proof-key> element', async () => {
    const discovery = await startFakeDiscovery('<wopi-discovery><net-zone name="external-http"/></wopi-discovery>')
    cleanups.push(discovery.close)
    const srv = await startTestServer({ proofRequired: true, collaboraInternalUrl: discovery.url })
    cleanups.push(srv.close)
    const keys = generateProofKeys()
    const url = signedUrl(srv, '/wopi/files/a.docx')
    const res = await getWithProof(srv, proofHeaders(keys.current.privateKey, url, 'devtoken'))
    expect(res.status).toBe(401)
  })

  it('also guards PutFile when proof is required', async () => {
    const { keys, srv } = await setup()
    const path = '/wopi/files/a.docx/contents'
    // unsigned -> 401
    let res = await fetch(`${srv.base}${path}?access_token=devtoken`, { method: 'POST', body: 'x' })
    expect(res.status).toBe(401)
    // signed -> 200
    const url = signedUrl(srv, path)
    res = await fetch(`${srv.base}${path}?access_token=devtoken`, {
      method: 'POST',
      body: 'signed-body',
      headers: proofHeaders(keys.current.privateKey, url, 'devtoken'),
    })
    expect(res.status).toBe(200)
  })
})

describe('proof disabled by default', () => {
  it('serves WOPI calls without any proof headers', async () => {
    const srv = await startTestServer({ proofRequired: false })
    cleanups.push(srv.close)
    const res = await fetch(`${srv.base}/wopi/files/a.docx?access_token=devtoken`)
    expect(res.status).toBe(200)
  })
})
