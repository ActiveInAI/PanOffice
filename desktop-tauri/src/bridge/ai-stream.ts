/**
 * Shared in-webview AI bridge behind window.pdfApi / window.desktop.
 *
 * Hosted PanOffice uses the same-origin, server-managed PanAI bridge so model
 * credentials never enter the webview. Standalone Tauri/dev builds retain the
 * direct-provider fallback via `@genoffice/ai-provider`.
 *
 * Extracted from pdf-api.ts (M2) so the docs bridge reuses the identical
 * code path; pdf behavior is unchanged.
 */
import {
  chatForProvider,
  defaultAiSettings,
  resolveAiSettings,
  streamForProvider,
} from '@genoffice/ai-provider'
import type {
  AiChatRequest,
  AiChatResponse,
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
} from '@genoffice/ai-provider'
import { isHostedByEflow, runEflowTurn } from './eflow-ai'
import { getServerPanAiConfig, runServerPanAiTurn } from './server-panai'

const AI_KEY = 'panoffice.ai'
/** Same default as the upstream Electron main handlers (sheets-main / ai-ipc) */
const DEFAULT_MAX_TOKENS = 8192

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

function managedSettings(defaults: AiSettings, model: string): AiSettings {
  return {
    ...defaults,
    provider: 'archgpt',
    providers: {
      ...defaults.providers,
      archgpt: {
        apiKey: 'server-managed',
        model,
        baseUrl: '/panai/v1',
      },
    },
  }
}

export interface AiBridge {
  getAiSettings(): Promise<AiSettings>
  setAiSettings(settings: AiSettings): Promise<void>
  aiChat(request: AiChatRequest): Promise<AiChatResponse>
  aiStream(request: AiStreamRequest): Promise<void>
  aiStreamCancel(requestId: string): Promise<void>
  onAiStream(handler: (chunk: AiStreamChunk) => void): () => void
}

/**
 * One independent AI surface (settings + stream registry) per installed app
 * API — call once per window.* shim.
 */
export function createAiBridge(): AiBridge {
  const streamHandlers = new Set<(chunk: AiStreamChunk) => void>()
  const activeStreams = new Map<string, AbortController>()

  async function getAiSettings(): Promise<AiSettings> {
    const defaults = defaultAiSettings()
    // These sentinel settings contain no credential. They only satisfy the
    // renderer's "configured" guard; the actual model and token stay server-side.
    if (isHostedByEflow()) return managedSettings(defaults, 'gpt-5.6-sol')
    const hosted = await getServerPanAiConfig()
    if (hosted.enabled) return managedSettings(defaults, hosted.model)
    const raw = localStorage.getItem(AI_KEY)
    if (!raw) return defaults
    try {
      return resolveAiSettings(JSON.parse(raw) as Partial<AiSettings>, defaults)
    } catch {
      return defaults
    }
  }

  function setAiSettings(settings: AiSettings): Promise<void> {
    localStorage.setItem(AI_KEY, JSON.stringify(settings))
    return Promise.resolve()
  }

  /** One-shot chat, matching the upstream 'ai:chat' handler's error shapes. */
  async function aiChat(request: AiChatRequest): Promise<AiChatResponse> {
    if (isHostedByEflow()) {
      try {
        const controller = new AbortController()
        const result = await runEflowTurn(
          { settings: request.settings, system: request.system, messages: [{ role: 'user', text: request.user }], tools: [] },
          controller.signal,
        )
        return { ok: true, content: result.text }
      } catch (err) {
        return { ok: false, error: errMsg(err) }
      }
    }
    const hosted = await getServerPanAiConfig()
    if (hosted.enabled) {
      try {
        const controller = new AbortController()
        const result = await runServerPanAiTurn(
          { system: request.system, messages: [{ role: 'user', text: request.user }], tools: [] },
          controller.signal,
        )
        return { ok: true, content: result.text }
      } catch (err) {
        return { ok: false, error: errMsg(err) }
      }
    }
    const { settings, system, user } = request
    const provider = settings.provider
    const config = settings.providers?.[provider]
    if (!config?.apiKey) {
      return {
        ok: false,
        error: provider === 'genspark' ? 'Not logged in to Genspark' : `No API key for ${provider}`,
      }
    }
    if (!config.model) return { ok: false, error: 'No model selected' }
    try {
      return await chatForProvider(provider, config, system, user)
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  /**
   * Stream one model turn straight from the webview (the Tauri shell has no
   * main-process proxy). Chunks fan out to every onAiStream subscriber, one
   * AbortController per requestId; aborting resolves as `done`, matching the
   * upstream Electron handlers.
   */
  async function aiStream(request: AiStreamRequest): Promise<void> {
    const { requestId } = request
    const send = (chunk: AiStreamChunk) => {
      for (const handler of streamHandlers) handler(chunk)
    }
    const provider = request.settings.provider
    const config = request.settings.providers[provider]
    if (!config) {
      send({ requestId, type: 'error', error: `Unknown provider: ${provider}` })
      return
    }
    const controller = new AbortController()
    activeStreams.set(requestId, controller)
    try {
      if (isHostedByEflow()) {
        const result = await runEflowTurn(request, controller.signal)
        if (result.toolCalls.length > 0) {
          for (const toolCall of result.toolCalls) send({ requestId, type: 'tool-call', toolCall })
        } else if (result.text) {
          send({ requestId, type: 'delta', text: result.text })
        }
        send({ requestId, type: 'done' })
        return
      }
      const hosted = await getServerPanAiConfig()
      if (hosted.enabled) {
        const result = await runServerPanAiTurn(request, controller.signal)
        if (result.toolCalls.length > 0) {
          for (const toolCall of result.toolCalls) send({ requestId, type: 'tool-call', toolCall })
        } else if (result.text) {
          send({ requestId, type: 'delta', text: result.text })
        }
        send({ requestId, type: 'done' })
        return
      }
      await streamForProvider(
        provider,
        config,
        request.system,
        request.messages,
        request.tools ?? [],
        request.maxTokens ?? DEFAULT_MAX_TOKENS,
        {
          signal: controller.signal,
          onDelta: (text) => send({ requestId, type: 'delta', text }),
          onToolCall: (toolCall) => send({ requestId, type: 'tool-call', toolCall }),
        },
      )
      send({ requestId, type: 'done' })
    } catch (err) {
      if (controller.signal.aborted) send({ requestId, type: 'done' })
      else send({ requestId, type: 'error', error: errMsg(err) })
    } finally {
      activeStreams.delete(requestId)
    }
  }

  function aiStreamCancel(requestId: string): Promise<void> {
    activeStreams.get(requestId)?.abort()
    return Promise.resolve()
  }

  function onAiStream(handler: (chunk: AiStreamChunk) => void): () => void {
    streamHandlers.add(handler)
    return () => streamHandlers.delete(handler)
  }

  return { getAiSettings, setAiSettings, aiChat, aiStream, aiStreamCancel, onAiStream }
}
