import type { AgentToolCall } from '@genoffice/agent-core'
import type { AiStreamRequest } from '@genoffice/ai-provider'
import { buildEflowPrompt, parseEflowToolCalls } from './eflow-ai'

export interface ServerPanAiConfig {
  enabled: boolean
  model: string
  /** Server-side allowlist a turn may pick from (always contains `model`). */
  models: string[]
}

export interface ServerPanAiTurnResult {
  text: string
  toolCalls: AgentToolCall[]
}

export interface ServerPanAiDeps {
  fetch: typeof fetch
}

const disabledConfig: ServerPanAiConfig = { enabled: false, model: '', models: [] }
let browserConfigPromise: Promise<ServerPanAiConfig> | null = null

function browserDeps(): ServerPanAiDeps {
  return { fetch: window.fetch.bind(window) }
}

async function loadConfig(deps: ServerPanAiDeps): Promise<ServerPanAiConfig> {
  try {
    const response = await deps.fetch('/panai/config', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      return disabledConfig
    }
    const payload = (await response.json()) as Partial<ServerPanAiConfig>
    if (payload.enabled !== true || typeof payload.model !== 'string' || !payload.model) {
      return disabledConfig
    }
    const models = Array.isArray(payload.models)
      ? payload.models.filter((model): model is string => typeof model === 'string' && !!model)
      : []
    return { enabled: true, model: payload.model, models: models.length > 0 ? models : [payload.model] }
  } catch {
    return disabledConfig
  }
}

/** Discover the same-origin server-managed PanAI bridge without exposing its credential. */
export function getServerPanAiConfig(deps?: ServerPanAiDeps): Promise<ServerPanAiConfig> {
  if (deps) return loadConfig(deps)
  browserConfigPromise ??= loadConfig(browserDeps())
  return browserConfigPromise
}

/** Run one tool-capable Office turn through the server-owned PanAI route.
 * `model` must come from the config's allowlist; omitted → server default. */
export async function runServerPanAiTurn(
  request: Pick<AiStreamRequest, 'system' | 'messages' | 'tools'>,
  signal: AbortSignal,
  deps: ServerPanAiDeps = browserDeps(),
  model?: string,
): Promise<ServerPanAiTurnResult> {
  const tools = request.tools ?? []
  const prompt = buildEflowPrompt(request.system, request.messages, tools)
  const response = await deps.fetch('/panai/turn', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(model ? { prompt, model } : { prompt }),
    signal,
  })
  let payload: { ok?: boolean; text?: unknown; error?: unknown } = {}
  try {
    payload = (await response.json()) as typeof payload
  } catch {
    // The status-specific message below remains safe and actionable.
  }
  if (!response.ok || payload.ok !== true || typeof payload.text !== 'string') {
    const detail = typeof payload.error === 'string' ? `：${payload.error}` : ''
    throw new Error(`PanAI 服务请求失败（HTTP ${response.status}）${detail}`)
  }
  return { text: payload.text, toolCalls: parseEflowToolCalls(payload.text, tools) }
}
