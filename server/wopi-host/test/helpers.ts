/**
 * Shared test helpers: temp data dirs, a real listening app on an ephemeral
 * port, a fake coolwsd discovery server carrying generated proof keys, and a
 * fake WOPI proof signer mirroring the coolwsd signing algorithm.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.js'
import type { WopiHostConfig } from '../src/config.js'
import { buildProofMessage, msToFiletime } from '../src/proof.js'

export function testConfig(overrides: Partial<WopiHostConfig> = {}): WopiHostConfig {
  return {
    port: 0,
    dataDir: '',
    devToken: 'devtoken',
    allowDevToken: true,
    devUiEnabled: true,
    devTokens: {},
    sharedToken: null,
    jwtSecret: null,
    jwksUrl: null,
    proofRequired: false,
    proofMaxSkewMs: 600_000,
    lockTtlMs: 30 * 60 * 1000,
    versionCap: 10,
    wopiPublicBase: 'http://wopi.test',
    collaboraInternalUrl: 'http://127.0.0.1:1',
    collaboraPublicUrl: 'http://127.0.0.1:1',
    pdfAppUrl: 'http://shell.test',
    pdfAppOrigin: 'http://shell.test',
    shellDir: null,
    xlsxRpcUrl: null,
    panAiBridgeUrl: null,
    panAiBridgeToken: null,
    panAiModel: 'gpt-5.6-sol',
    ...overrides,
  }
}

export interface TestServer {
  base: string
  dataDir: string
  cfg: WopiHostConfig
  /** Stop listening; keep the data dir. */
  stop: () => Promise<void>
  /** Stop listening; remove the data dir if this helper created it. */
  close: () => Promise<void>
}

export async function startTestServer(
  overrides: Partial<WopiHostConfig> = {},
  files: Record<string, string | Buffer> = { 'a.docx': 'original-a-bytes' },
): Promise<TestServer> {
  const createdDir = !overrides.dataDir
  const dataDir = overrides.dataDir ?? (await mkdtemp(join(tmpdir(), 'wopi-host-test-')))
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dataDir, name), content)
  }
  const cfg = testConfig({ ...overrides, dataDir })
  const { app } = await createApp(cfg)
  const server = await new Promise<http.Server>((res) => {
    const s = app.listen(0, '127.0.0.1', () => res(s))
  })
  const { port } = server.address() as AddressInfo
  const stop = async () => {
    server.closeAllConnections()
    await new Promise<void>((res) => server.close(() => res()))
  }
  return {
    base: `http://127.0.0.1:${port}`,
    dataDir,
    cfg,
    stop,
    close: async () => {
      await stop()
      if (createdDir) await rm(dataDir, { recursive: true, force: true })
    },
  }
}

/** URL helper: WOPI path with access_token query (as coolwsd would call it). */
export function wopiUrl(base: string, path: string, token = 'devtoken'): string {
  const sep = path.includes('?') ? '&' : '?'
  return `${base}${path}${sep}access_token=${encodeURIComponent(token)}`
}

// ---- fake coolwsd proof infrastructure ----

export interface FakeProofKeys {
  current: { publicKey: KeyObject; privateKey: KeyObject }
  old: { publicKey: KeyObject; privateKey: KeyObject } | null
}

export function generateProofKeys(withOld = false): FakeProofKeys {
  const gen = () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    return { publicKey, privateKey }
  }
  return { current: gen(), old: withOld ? gen() : null }
}

function b64urlToB64(b64url: string): string {
  return Buffer.from(b64url, 'base64url').toString('base64')
}

/** Minimal discovery XML with a <proof-key/> element for the given keys. */
export function discoveryXmlWithProofKeys(keys: FakeProofKeys): string {
  const cur = keys.current.publicKey.export({ format: 'jwk' }) as { n: string; e: string }
  let attrs = `modulus="${b64urlToB64(cur.n)}" exponent="${b64urlToB64(cur.e)}"`
  if (keys.old) {
    const old = keys.old.publicKey.export({ format: 'jwk' }) as { n: string; e: string }
    attrs += ` oldmodulus="${b64urlToB64(old.n)}" oldexponent="${b64urlToB64(old.e)}"`
  }
  return `<wopi-discovery><net-zone name="external-http"/><proof-key ${attrs}/></wopi-discovery>`
}

/** Tiny HTTP server that answers /hosting/discovery with the given XML. */
export async function startFakeDiscovery(xml: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/hosting/discovery') {
      res.setHeader('Content-Type', 'application/xml')
      res.end(xml)
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((res) => server.close(() => res()))
    },
  }
}

/**
 * Sign a WOPI proof exactly like coolwsd does (per the MS proof-key spec):
 * RSA-SHA256 over the length-prefixed url/token/timestamp tuple. `url` must
 * be the absolute URL including the access_token query; it is uppercased
 * inside buildProofMessage, matching the spec.
 */
export function signWopiProof(privateKey: KeyObject, url: string, token: string, timestamp: bigint): string {
  return sign('RSA-SHA256', buildProofMessage(url, token, timestamp), privateKey).toString('base64')
}

/** Build X-WOPI-* proof headers for a request to `url` signed by `privateKey`. */
export function proofHeaders(
  privateKey: KeyObject,
  url: string,
  token: string,
  atMs: number = Date.now(),
  headerName = 'X-WOPI-Proof',
): Record<string, string> {
  const ts = msToFiletime(atMs)
  return {
    [headerName]: signWopiProof(privateKey, url, token, ts),
    'X-WOPI-TimeStamp': ts.toString(),
  }
}
