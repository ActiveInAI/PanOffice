import type { AiSettings, AiStreamRequest } from '@genoffice/ai-provider'
import { describe, expect, it } from 'vitest'
import {
  buildEflowPrompt,
  parseEflowToolCalls,
  runEflowTurn,
  selectEflowAgent,
  type EflowTransportDeps,
} from '../src/bridge/eflow-ai'

const settings: AiSettings = {
  provider: 'anthropic',
  providers: {
    archgpt: { apiKey: '', model: '', baseUrl: '' },
    genspark: { apiKey: '', model: '' },
    anthropic: { apiKey: '', model: 'claude-sonnet' },
    gemini: { apiKey: '', model: '' },
    deepseek: { apiKey: '', model: '' },
    openai: { apiKey: '', model: '' },
    custom: { apiKey: '', model: '', baseUrl: '' },
  },
}

describe('EFlow PanOffice AI bridge', () => {
  it('selects a real CLI agent without exposing provider credentials', () => {
    expect(selectEflowAgent(settings)).toBe('claude')
    expect(selectEflowAgent({ ...settings, provider: 'gemini' })).toBe('gemini')
  })

  it('builds a Chinese tool-capable prompt and parses only allowlisted calls', () => {
    const tools = [{ name: 'replace_text', description: '替换文本', inputSchema: { type: 'object' } }]
    const prompt = buildEflowPrompt('编辑文档', [{ role: 'user', text: '修改标题' }], tools)
    expect(prompt).toContain('PanOffice')
    expect(prompt).toContain('AVAILABLE_TOOLS')
    expect(parseEflowToolCalls('{"tool_calls":[{"id":"1","name":"replace_text","arguments":{"text":"新"}}]}', tools)).toEqual([
      { id: '1', name: 'replace_text', input: { text: '新' } },
    ])
    expect(parseEflowToolCalls('{"tool_calls":[{"id":"2","name":"shell","arguments":{}}]}', tools)).toEqual([])
  })

  it('creates a full-access temporary ACP turn, consumes WS output, and deletes the conversation', async () => {
    const calls: Array<{ path: string; init: RequestInit; body?: Record<string, unknown> }> = []
    class FakeSocket {
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      close(): void {}
      emit(name: string, data: Record<string, unknown>): void {
        this.onmessage?.({ data: JSON.stringify({ name, data }) } as MessageEvent<string>)
      }
    }
    const socket = new FakeSocket()
    const deps: EflowTransportDeps = {
      csrfToken: () => 'csrf-test',
      selectedModel: async () => ({
        id: 'provider:deepseek-id:deepseek-v4-flash',
        family: 'deepseek',
        label: 'DeepSeek · deepseek-v4-flash',
        model: 'deepseek-v4-flash',
        agent: 'codex',
        providerId: 'deepseek-id',
      }),
      openSocket: () => {
        queueMicrotask(() => socket.onopen?.(new Event('open')))
        return socket
      },
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
        calls.push({ path, init, body })
        if (path === '/api/conversations') {
          return Response.json({ success: true, data: { id: 'conv-1' } })
        }
        if (path.endsWith('/messages')) {
          queueMicrotask(() => {
            socket.emit('message.stream', {
              conversation_id: 'conv-1',
              turn_id: 'turn-1',
              type: 'content',
              data: { content: '已完成' },
            })
            socket.emit('turn.completed', { conversation_id: 'conv-1', turn_id: 'turn-1' })
          })
          return Response.json({ success: true, data: { turn_id: 'turn-1' } })
        }
        if (init.method === 'DELETE') return Response.json({ success: true, data: true })
        throw new Error(`unexpected request ${path}`)
      }) as typeof fetch,
    }
    const request: Pick<AiStreamRequest, 'settings' | 'system' | 'messages' | 'tools'> = {
      settings,
      system: '编辑文档',
      messages: [{ role: 'user', text: '你好' }],
      tools: [],
    }
    const result = await runEflowTurn(request, new AbortController().signal, deps)
    expect(result.text).toBe('已完成')
    const create = calls.find((call) => call.path === '/api/conversations')
    expect(create?.body).toMatchObject({
      type: 'acp',
      extra: {
        backend: 'codex',
        agent_name: 'codex',
        session_mode: 'skipAll',
        current_model_id: 'deepseek-v4-flash',
        provider_id: 'deepseek-id',
        provider_model_id: 'deepseek-v4-flash',
      },
    })
    expect(create?.body).not.toHaveProperty('model')
    expect(calls.some((call) => call.init.method === 'DELETE')).toBe(true)
    expect(calls.every((call) => new Headers(call.init.headers).get('x-csrf-token') === 'csrf-test')).toBe(true)
  })
})
