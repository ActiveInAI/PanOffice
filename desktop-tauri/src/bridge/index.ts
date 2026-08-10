/**
 * Bridge shim — the heart of the Electron→Tauri port.
 *
 * Upstream GenOffice renderers never import Electron; they call preload
 * globals: window.pdfApi (pdf), window.desktop (docs/slides), window.desktopApi
 * (sheets), window.slidesApi (slides), window.aiOffice* / window.projectApi
 * (shell). Upstream preloads implement them with contextBridge +
 * ipcRenderer.invoke/on/send — a 1:1 match for Tauri's invoke()/listen().
 *
 * Porting pattern per app:
 *   1. copy the app's preload method list into a shim here (same names,
 *      same argument order),
 *   2. back each method by a Rust command (src-tauri/src/commands.rs) or by
 *      pure JS inside the webview when the upstream handler was pure JS,
 *   3. events (menu commands, close-requested…) map to listen()/emit().
 *
 * Only a minimal demonstration set is implemented at M1. Everything else
 * throws loudly so a half-ported app fails fast instead of silently
 * degrading.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { installDesktopApi } from './desktop-api'
import { installPdfApi } from './pdf-api'
import { installSheetsApi } from './sheets-api'
import { installSlidesApi } from './slides-api'

declare global {
  interface Window {
    /** Injected by the Tauri runtime; absent in a plain browser (dev / headless tests) */
    __TAURI_INTERNALS__?: unknown
  }
}

/** Rust command wrappers — file IO used by every editor. */
const file = {
  /** Read a file as bytes (number array over IPC; fine for small files —
   *  switch to tauri::ipc::Response streaming when porting large xlsx). */
  readFile: (path: string): Promise<number[]> => invoke('read_file', { path }),
  writeFile: (path: string, bytes: number[]): Promise<void> =>
    invoke('write_file', { path, bytes }),
}

/** Menu / host-event subscription pattern (maps ipcRenderer.on). */
function onHostEvent(event: string, cb: (payload: unknown) => void): Promise<UnlistenFn> {
  return listen(event, (e) => cb(e.payload))
}

declare global {
  interface Window {
    panofficeBridge?: unknown
  }
}

export function installBridge(): void {
  // Registry object so ported code and tests can introspect what's live.
  window.panofficeBridge = { file, onHostEvent }

  // M2: the pdf editor's host surface (window.pdfApi), backed by the Rust
  // file commands in the Tauri webview and by the IndexedDB byte-store
  // overlay in a plain browser.
  installPdfApi()
  // The docs editor's host surface (window.desktop + window.projectApi), same
  // backing.
  installDesktopApi()
  // M3: the sheets editor's host surface (window.desktopApi + window.projectApi),
  // backed by the xlsx sidecar through the xlsx-RPC channel (Rust xlsx_rpc
  // command in the app, tools/xlsx-sidecar-server.mjs in the browser).
  installSheetsApi()
  // M4: the slides editor's host surface (window.slidesApi). The whole editing
  // kernel (pptx-engine) runs in the webview — see slides-api.ts.
  installSlidesApi()
}
