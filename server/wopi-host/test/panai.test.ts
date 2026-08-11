import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function startFakeBridge() {
  const calls: Array<{ authorization: string; body: Record<string, unknown> }> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      calls.push({ authorization: String(req.headers.authorization ?? ''), body })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: '真实 PanAI 回复' } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function panAiPost(server: TestServer, prompt: string, origin = server.cfg.pdfAppOrigin) {
  return fetch(`${server.base}/panai/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ prompt }),
  })
}

describe('server-managed PanAI bridge', () => {
  it('reports disabled and fails closed when no server credential is configured', async () => {
    const server = await startTestServer()
    cleanups.push(server.close)

    expect(await (await fetch(`${server.base}/panai/config`)).json()).toEqual({
      enabled: false,
      model: '',
    })
    expect((await panAiPost(server, 'hello')).status).toBe(503)
  })

  it('keeps the credential server-side, rejects foreign origins, and forces the configured model', async () => {
    const bridge = await startFakeBridge()
    cleanups.push(bridge.close)
    const server = await startTestServer({
      panAiBridgeUrl: bridge.baseUrl,
      panAiBridgeToken: 's'.repeat(64),
      panAiModel: 'gpt-5.6-sol',
    })
    cleanups.push(server.close)

    const configResponse = await fetch(`${server.base}/panai/config`)
    const configText = await configResponse.text()
    expect(JSON.parse(configText)).toEqual({ enabled: true, model: 'gpt-5.6-sol' })
    expect(configText).not.toContain('s'.repeat(64))

    expect((await panAiPost(server, 'hello', 'http://foreign.test')).status).toBe(403)
    const response = await panAiPost(server, '编辑这份文档')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      text: '真实 PanAI 回复',
      model: 'gpt-5.6-sol',
    })
    expect(bridge.calls).toHaveLength(1)
    expect(bridge.calls[0].authorization).toBe(`Bearer ${'s'.repeat(64)}`)
    expect(bridge.calls[0].body).toMatchObject({ model: 'gpt-5.6-sol', stream: false })
    expect(JSON.stringify(bridge.calls[0].body)).toContain('编辑这份文档')
  })

  it('rejects empty prompts before contacting the bridge', async () => {
    const bridge = await startFakeBridge()
    cleanups.push(bridge.close)
    const server = await startTestServer({
      panAiBridgeUrl: bridge.baseUrl,
      panAiBridgeToken: 't'.repeat(64),
    })
    cleanups.push(server.close)

    expect((await panAiPost(server, '   ')).status).toBe(400)
    expect(bridge.calls).toHaveLength(0)
  })
})
