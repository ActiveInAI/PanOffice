/**
 * Shared in-webview AI bridge behind window.pdfApi / window.desktop.
 *
 * Upstream, the Electron main process proxied AI calls (avoids renderer CORS
 * and keeps provider keys out of the webview); the Tauri shell has no main
 * process, so streaming runs directly in the webview via
 * `@genoffice/ai-provider`'s streamForProvider/chatForProvider. Settings live
 * in localStorage (upstream persisted ai-settings.json under userData).
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

const AI_KEY = 'panoffice.ai'
/** Same default as the upstream Electron main handlers (sheets-main / ai-ipc) */
const DEFAULT_MAX_TOKENS = 8192

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

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

  function getAiSettings(): Promise<AiSettings> {
    const defaults = defaultAiSettings()
    const raw = localStorage.getItem(AI_KEY)
    if (!raw) return Promise.resolve(defaults)
    try {
      return Promise.resolve(resolveAiSettings(JSON.parse(raw) as Partial<AiSettings>, defaults))
    } catch {
      return Promise.resolve(defaults)
    }
  }

  function setAiSettings(settings: AiSettings): Promise<void> {
    localStorage.setItem(AI_KEY, JSON.stringify(settings))
    return Promise.resolve()
  }

  /** One-shot chat, matching the upstream 'ai:chat' handler's error shapes. */
  async function aiChat(request: AiChatRequest): Promise<AiChatResponse> {
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
