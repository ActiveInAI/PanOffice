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
      models: [],
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
    expect(JSON.parse(configText)).toEqual({
      enabled: true,
      model: 'gpt-5.6-sol',
      models: ['gpt-5.6-sol'],
    })
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

describe('multi-model PanAI routing', () => {
  function turnPost(server: TestServer, body: Record<string, unknown>) {
    return fetch(`${server.base}/panai/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.cfg.pdfAppOrigin },
      body: JSON.stringify(body),
    })
  }

  it('routes deepseek models to the DeepSeek upstream and others to the bridge', async () => {
    const bridge = await startFakeBridge()
    const deepseek = await startFakeBridge()
    cleanups.push(bridge.close, deepseek.close)
    const server = await startTestServer({
      panAiBridgeUrl: bridge.baseUrl,
      panAiBridgeToken: 'b'.repeat(64),
      panAiModel: 'deepseek-v4-flash',
      panAiModels: ['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-5.6-sol'],
      panAiDeepseekUrl: deepseek.baseUrl,
      panAiDeepseekToken: 'd'.repeat(64),
    })
    cleanups.push(server.close)

    expect(await (await fetch(`${server.base}/panai/config`)).json()).toEqual({
      enabled: true,
      model: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-5.6-sol'],
    })

    // default (no model in body) → deepseek default upstream
    expect((await turnPost(server, { prompt: '总结' })).status).toBe(200)
    // explicit pro → deepseek upstream; explicit gpt → cli bridge
    expect((await turnPost(server, { prompt: '总结', model: 'deepseek-v4-pro' })).status).toBe(200)
    expect((await turnPost(server, { prompt: '总结', model: 'gpt-5.6-sol' })).status).toBe(200)

    expect(deepseek.calls.map((call) => call.body.model)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ])
    expect(deepseek.calls.every((call) => call.authorization === `Bearer ${'d'.repeat(64)}`)).toBe(true)
    expect(bridge.calls.map((call) => call.body.model)).toEqual(['gpt-5.6-sol'])
    expect(bridge.calls[0].authorization).toBe(`Bearer ${'b'.repeat(64)}`)
  })

  it('rejects models outside the allowlist and hides unservable ones from config', async () => {
    const bridge = await startFakeBridge()
    cleanups.push(bridge.close)
    const server = await startTestServer({
      panAiBridgeUrl: bridge.baseUrl,
      panAiBridgeToken: 'b'.repeat(64),
      panAiModel: 'gpt-5.6-sol',
      // deepseek listed but no deepseek upstream configured → not servable
      panAiModels: ['gpt-5.6-sol', 'deepseek-v4-flash'],
    })
    cleanups.push(server.close)

    expect(await (await fetch(`${server.base}/panai/config`)).json()).toEqual({
      enabled: true,
      model: 'gpt-5.6-sol',
      models: ['gpt-5.6-sol'],
    })
    expect((await turnPost(server, { prompt: '总结', model: 'deepseek-v4-flash' })).status).toBe(400)
    expect((await turnPost(server, { prompt: '总结', model: 'made-up' })).status).toBe(400)
    expect(bridge.calls).toHaveLength(0)
  })
})
