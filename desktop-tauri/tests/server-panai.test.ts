import type { AiStreamRequest } from '@genoffice/ai-provider'
import { describe, expect, it } from 'vitest'
import {
  getServerPanAiConfig,
  runServerPanAiTurn,
  type ServerPanAiDeps,
} from '../src/bridge/server-panai'

describe('server-managed PanAI client bridge', () => {
  it('discovers the server-owned model without receiving a credential', async () => {
    const deps: ServerPanAiDeps = {
      fetch: (async () => Response.json({ enabled: true, model: 'gpt-5.6-sol' })) as typeof fetch,
    }
    expect(await getServerPanAiConfig(deps)).toEqual({
      enabled: true,
      model: 'gpt-5.6-sol',
      models: ['gpt-5.6-sol'],
    })
  })

  it('sends the tool-capable Office prompt and converts allowlisted tool calls', async () => {
    let postedPrompt = ''
    const deps: ServerPanAiDeps = {
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        postedPrompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt
        return Response.json({
          ok: true,
          text: '{"tool_calls":[{"id":"call-1","name":"replace_text","arguments":{"text":"PanAI"}}]}',
        })
      }) as typeof fetch,
    }
    const request: Pick<AiStreamRequest, 'system' | 'messages' | 'tools'> = {
      system: '编辑 Word 文档',
      messages: [{ role: 'user', text: '把标题改成 PanAI' }],
      tools: [{ name: 'replace_text', description: '替换文本', inputSchema: { type: 'object' } }],
    }
    const result = await runServerPanAiTurn(request, new AbortController().signal, deps)
    expect(postedPrompt).toContain('AVAILABLE_TOOLS')
    expect(postedPrompt).toContain('把标题改成 PanAI')
    expect(result.toolCalls).toEqual([
      { id: 'call-1', name: 'replace_text', input: { text: 'PanAI' } },
    ])
  })

  it('surfaces a safe error when the hosted route is unavailable', async () => {
    const deps: ServerPanAiDeps = {
      fetch: (async () => Response.json({ ok: false, error: 'disabled' }, { status: 503 })) as typeof fetch,
    }
    await expect(
      runServerPanAiTurn(
        { system: 's', messages: [{ role: 'user', text: 'u' }], tools: [] },
        new AbortController().signal,
        deps,
      ),
    ).rejects.toThrow(/HTTP 503/)
  })
})
