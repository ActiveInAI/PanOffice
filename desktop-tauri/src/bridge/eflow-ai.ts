import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import type { AiSettings, AiStreamRequest } from '@genoffice/ai-provider'

interface EflowEnvelope<T> {
  success: boolean
  data?: T
  message?: string
  msg?: string
}

interface ConversationResponse {
  id: string
}

interface SendResponse {
  turn_id: string
}

interface WsEvent {
  name: string
  data: Record<string, unknown>
}

interface SocketLike {
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<string>) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  close(): void
}

export interface EflowTransportDeps {
  fetch: typeof fetch
  openSocket(): SocketLike
  csrfToken(): string
}

export interface EflowTurnResult {
  text: string
  toolCalls: AgentToolCall[]
}

const MAX_PROMPT_CHARS = 512_000
const TURN_TIMEOUT_MS = 120_000

function browserDeps(): EflowTransportDeps {
  return {
    fetch: window.fetch.bind(window),
    openSocket: () => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      return new WebSocket(`${protocol}//${location.host}/ws`) as SocketLike
    },
    csrfToken: () => {
      const entry = document.cookie
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('panai-csrf-token='))
      return entry ? decodeURIComponent(entry.slice('panai-csrf-token='.length)) : ''
    },
  }
}

export function isHostedByEflow(): boolean {
  return typeof location !== 'undefined' && (location.pathname === '/panoffice' || location.pathname.startsWith('/panoffice/'))
}

export function selectEflowAgent(settings: AiSettings): string {
  const model = settings.providers?.[settings.provider]?.model ?? ''
  const hint = `${settings.provider} ${model}`.toLowerCase()
  if (hint.includes('codebuddy')) return 'codebuddy'
  if (hint.includes('qwen')) return 'qwen'
  if (hint.includes('kimi') || hint.includes('moonshot')) return 'kimi'
  if (hint.includes('gemini') || settings.provider === 'gemini') return 'gemini'
  if (hint.includes('claude') || settings.provider === 'anthropic') return 'claude'
  return 'codex'
}

function messageForWire(message: AgentMessage): Record<string, unknown> {
  if (message.role === 'tool') return { role: message.role, results: message.results }
  return {
    role: message.role,
    text: message.text,
    ...(message.role === 'assistant' && message.toolCalls ? { toolCalls: message.toolCalls } : {}),
  }
}

export function buildEflowPrompt(system: string, messages: AgentMessage[], tools: AgentToolDef[]): string {
  const prompt = [
    '你是 PanAI，PanOffice 的 Office 智能体。请使用中文完成当前任务。',
    '如果无需调用工具，直接输出最终答复。',
    '如果需要调用工具，只输出一个 JSON 对象，格式为：',
    '{"tool_calls":[{"id":"唯一ID","name":"工具名","arguments":{}}]}',
    '工具名必须来自 AVAILABLE_TOOLS，arguments 必须符合对应 inputSchema；不要添加 Markdown 代码围栏。',
    `SYSTEM:\n${system}`,
    `AVAILABLE_TOOLS:\n${JSON.stringify(tools)}`,
    `MESSAGES:\n${JSON.stringify(messages.map(messageForWire))}`,
  ].join('\n\n')
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error('PanOffice 请求上下文超过安全上限')
  return prompt
}

export function parseEflowToolCalls(text: string, tools: AgentToolDef[]): AgentToolCall[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { tool_calls?: unknown }).tool_calls)) return []
  const allowed = new Set(tools.map((tool) => tool.name))
  const calls: AgentToolCall[] = []
  for (const raw of (parsed as { tool_calls: unknown[] }).tool_calls) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const name = typeof item.name === 'string' ? item.name : ''
    const input = item.arguments
    if (!allowed.has(name) || !input || typeof input !== 'object' || Array.isArray(input)) continue
    calls.push({
      id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID(),
      name,
      input: input as Record<string, unknown>,
    })
  }
  return calls
}

function extractText(data: Record<string, unknown>): string {
  const payload = data.data
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object') {
    const content = (payload as Record<string, unknown>).content
    if (typeof content === 'string') return content
  }
  return ''
}

async function requestJson<T>(
  deps: EflowTransportDeps,
  path: string,
  init: RequestInit,
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (init.body) headers.set('content-type', 'application/json')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = deps.csrfToken()
    if (!csrf) throw new Error('EFlow CSRF 会话不可用')
    headers.set('x-csrf-token', csrf)
  }
  const response = await deps.fetch(path, { ...init, headers, credentials: 'include' })
  if (!response.ok) throw new Error(`EFlow API ${response.status}`)
  const envelope = (await response.json()) as EflowEnvelope<T>
  if (!envelope.success || envelope.data === undefined) {
    throw new Error(envelope.message || envelope.msg || 'EFlow API 返回失败')
  }
  return envelope.data
}

async function cleanupConversation(deps: EflowTransportDeps, conversationId: string): Promise<void> {
  try {
    await requestJson<unknown>(deps, `/api/conversations/${encodeURIComponent(conversationId)}`, { method: 'DELETE' })
  } catch {
    // Best effort only. The server also prunes abandoned temporary sessions.
  }
}

export async function runEflowTurn(
  request: Pick<AiStreamRequest, 'settings' | 'system' | 'messages' | 'tools'>,
  signal: AbortSignal,
  deps: EflowTransportDeps = browserDeps(),
): Promise<EflowTurnResult> {
  const socket = deps.openSocket()
  let conversationId = ''
  let turnId = ''
  let finalText = ''
  let streamError = ''
  let completed = false
  let completeTurn: (() => void) | null = null
  let failTurn: ((error: Error) => void) | null = null

  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('EFlow WebSocket 连接超时')), 8_000)
    socket.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error('EFlow WebSocket 连接失败'))
    }
  })
  const turnDone = new Promise<void>((resolve, reject) => {
    completeTurn = resolve
    failTurn = reject
  })

  socket.onmessage = (event) => {
    let message: WsEvent
    try {
      message = JSON.parse(String(event.data)) as WsEvent
    } catch {
      return
    }
    const data = message.data ?? {}
    if (data.conversation_id !== conversationId) return
    if (turnId && typeof data.turn_id === 'string' && data.turn_id !== turnId) return
    if (message.name === 'message.stream') {
      const type = typeof data.type === 'string' ? data.type : ''
      if (type === 'content' || type === 'text') {
        const text = extractText(data)
        finalText = data.replace === true ? text : `${finalText}${text}`
      } else if (type === 'error') {
        streamError = extractText(data) || 'EFlow 智能体返回错误'
      }
    } else if (message.name === 'turn.completed' && !completed) {
      completed = true
      const last = data.last_message
      if (!finalText && last && typeof last === 'object') {
        const content = (last as Record<string, unknown>).content
        if (typeof content === 'string') finalText = content
      }
      completeTurn?.()
    }
  }
  socket.onclose = () => {
    if (!completed) failTurn?.(new Error('EFlow WebSocket 已断开'))
  }

  const timeout = setTimeout(() => failTurn?.(new Error('EFlow 智能体响应超时')), TURN_TIMEOUT_MS)
  const onAbort = () => failTurn?.(new DOMException('已取消', 'AbortError'))
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    await opened
    const agent = selectEflowAgent(request.settings)
    const conversation = await requestJson<ConversationResponse>(deps, '/api/conversations', {
      method: 'POST',
      body: JSON.stringify({
        type: 'acp',
        name: 'PanOffice 临时任务',
        extra: {
          backend: agent,
          agent_name: agent,
          session_mode: 'skipAll',
          custom_workspace: false,
        },
      }),
    })
    conversationId = conversation.id
    const prompt = buildEflowPrompt(request.system, request.messages, request.tools ?? [])
    const sent = await requestJson<SendResponse>(
      deps,
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      { method: 'POST', body: JSON.stringify({ content: prompt, files: [], inject_skills: [], hidden: false }) },
    )
    turnId = sent.turn_id
    await turnDone
    if (streamError) throw new Error(streamError)
    const tools = request.tools ?? []
    return { text: finalText, toolCalls: parseEflowToolCalls(finalText, tools) }
  } catch (error) {
    if (signal.aborted && conversationId && turnId) {
      try {
        await requestJson<unknown>(deps, `/api/conversations/${encodeURIComponent(conversationId)}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ turn_id: turnId }),
        })
      } catch {
        // Cleanup below remains authoritative.
      }
    }
    throw error
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
    socket.close()
    if (conversationId) await cleanupConversation(deps, conversationId)
  }
}
