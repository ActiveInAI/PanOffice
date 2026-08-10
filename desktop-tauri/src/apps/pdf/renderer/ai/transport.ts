import type { AgentTransport } from '@genoffice/agent-core'
import { streamForProvider } from '@genoffice/ai-provider'
import type { AiSettings } from '@genoffice/ai-provider'

/** Same default as the upstream Electron main handlers (sheets-main / ai-ipc) */
const DEFAULT_MAX_TOKENS = 8192

/**
 * Direct in-webview transport (Tauri port): upstream streamed from the Electron
 * main process over IPC (createIpcTransport); the Tauri shell has no
 * main-process proxy, so the renderer fetches from the provider itself.
 * Abort semantics match upstream: cancel() aborts and the turn ends as onDone.
 */
export function createDirectTransport(getSettings: () => AiSettings): AgentTransport {
  return {
    stream(request, cb) {
      const settings = getSettings()
      const config = settings.providers[settings.provider]
      if (!config) {
        cb.onError(`Unknown provider: ${settings.provider}`)
        return { cancel: () => {} }
      }
      const controller = new AbortController()
      void streamForProvider(
        settings.provider,
        config,
        request.system,
        request.messages,
        request.tools,
        DEFAULT_MAX_TOKENS,
        { signal: controller.signal, onDelta: cb.onDelta, onToolCall: cb.onToolCall },
      ).then(
        () => cb.onDone(),
        (err: unknown) => {
          if (controller.signal.aborted) cb.onDone()
          else cb.onError(err instanceof Error ? err.message : String(err))
        },
      )
      return { cancel: () => controller.abort() }
    },
  }
}
