import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { startTestServer } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).reverse().map((cleanup) => cleanup()))
})

async function startRpcStub(): Promise<{
  url: string
  bodies: string[]
  close: () => Promise<void>
}> {
  const bodies: string[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ version: 1, requestId: 'stub', ok: true, result: { sheets: 1 } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/rpc`,
    bodies,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe('same-origin XLSX RPC bridge', () => {
  it('is absent when no loopback XLSX endpoint is configured', async () => {
    const srv = await startTestServer({ xlsxRpcUrl: null })
    cleanups.push(srv.close)
    const response = await fetch(`${srv.base}/xlsx-sidecar/rpc`, {
      method: 'POST',
      headers: { origin: 'http://shell.test', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(404)
  })

  it('rejects foreign origins and forwards the exact JSON body for the shell', async () => {
    const rpc = await startRpcStub()
    cleanups.push(rpc.close)
    const srv = await startTestServer({ xlsxRpcUrl: rpc.url })
    cleanups.push(srv.close)
    const payload = JSON.stringify({ version: 1, requestId: 'abc', command: 'open', path: '/tmp/a' })

    const forbidden = await fetch(`${srv.base}/xlsx-sidecar/rpc`, {
      method: 'POST',
      headers: { origin: 'http://foreign.test', 'content-type': 'application/json' },
      body: payload,
    })
    expect(forbidden.status).toBe(403)
    expect(rpc.bodies).toHaveLength(0)

    const accepted = await fetch(`${srv.base}/xlsx-sidecar/rpc`, {
      method: 'POST',
      headers: { origin: 'http://shell.test', 'content-type': 'application/json' },
      body: payload,
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ ok: true, result: { sheets: 1 } })
    expect(rpc.bodies).toEqual([payload])
  })

  it('reports an unavailable loopback engine without exposing internals', async () => {
    const srv = await startTestServer({ xlsxRpcUrl: 'http://127.0.0.1:1/rpc' })
    cleanups.push(srv.close)
    const response = await fetch(`${srv.base}/xlsx-sidecar/rpc`, {
      method: 'POST',
      headers: { origin: 'http://shell.test', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: 'xlsx_rpc_unavailable', message: 'XLSX service unavailable.' },
    })
  })
})
