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

describe('server-side store staging (host.stage_store_file)', () => {
  async function startStageStub(): Promise<{
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
        res.end(
          JSON.stringify({ version: 1, requestId: 'stub', ok: true, result: { path: '/stage/报表.xlsx' } }),
        )
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

  it('stages a store file on the host and reports its sha256 without a byte round trip', async () => {
    const rpc = await startStageStub()
    cleanups.push(rpc.close)
    const srv = await startTestServer({ xlsxRpcUrl: rpc.url }, { '报表.xlsx': 'workbook-bytes' })
    cleanups.push(srv.close)

    const response = await fetch(`${srv.base}/xlsx-sidecar/rpc`, {
      method: 'POST',
      headers: { origin: 'http://shell.test', 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        requestId: 'r1',
        command: 'host.stage_store_file',
        name: '报表.xlsx',
      }),
    })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      ok: boolean
      result: { path: string; sha256: string; size: number }
    }
    expect(payload.ok).toBe(true)
    expect(payload.result.path).toBe('/stage/报表.xlsx')
    expect(payload.result.size).toBe('workbook-bytes'.length)
    // sha256('workbook-bytes')
    expect(payload.result.sha256).toMatch(/^[0-9a-f]{64}$/)

    // The sidecar received a host.stage carrying the store bytes.
    const forwarded = JSON.parse(rpc.bodies[0]!) as {
      command: string
      path: string
      base64: string
    }
    expect(forwarded.command).toBe('host.stage')
    expect(forwarded.path).toBe('local/报表.xlsx')
    expect(Buffer.from(forwarded.base64, 'base64').toString('utf8')).toBe('workbook-bytes')
  })

  it('answers not_found for unknown or path-escaping names without touching the sidecar', async () => {
    const rpc = await startStageStub()
    cleanups.push(rpc.close)
    const srv = await startTestServer({ xlsxRpcUrl: rpc.url })
    cleanups.push(srv.close)

    for (const name of ['no-such.xlsx', '../secrets.xlsx', '.wopi-locks.json']) {
      const response = await fetch(`${srv.base}/xlsx-sidecar/rpc`, {
        method: 'POST',
        headers: { origin: 'http://shell.test', 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, requestId: 'r2', command: 'host.stage_store_file', name }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'not_found' } })
    }
    expect(rpc.bodies).toHaveLength(0)
  })

  it('still forwards ordinary envelopes untouched', async () => {
    const rpc = await startStageStub()
    cleanups.push(rpc.close)
    const srv = await startTestServer({ xlsxRpcUrl: rpc.url })
    cleanups.push(srv.close)
    const payload = JSON.stringify({ version: 1, requestId: 'r3', command: 'open', path: '/tmp/x' })
    const response = await fetch(`${srv.base}/xlsx-sidecar/rpc`, {
      method: 'POST',
      headers: { origin: 'http://shell.test', 'content-type': 'application/json' },
      body: payload,
    })
    expect(response.status).toBe(200)
    expect(rpc.bodies).toEqual([payload])
  })
})
