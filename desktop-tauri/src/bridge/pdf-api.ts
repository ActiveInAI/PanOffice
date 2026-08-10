/**
 * window.pdfApi — the pdf editor's host surface, ported from the Electron
 * preload + main handlers (desktop/apps/pdf/src/{preload,main}) onto the
 * Tauri shell.
 *
 * Everything that was pure JS upstream (save/extract/insert via pdf-lib)
 * runs in the webview here; only raw file IO crosses into Rust (or the
 * browser byte-store overlay, see ./platform.ts). Method semantics follow
 * desktop/apps/pdf/src/main/pdf-main.ts; the close-handshake trio and the
 * native dialogs are stubs until M3 (real window lifecycle + tauri dialog
 * plugin).
 */
import { LANGS } from '@genoffice/i18n'
import type { Lang } from '@genoffice/i18n'
import { applySaveRequest, extractPagesBytes, insertPdfBytes } from '../apps/pdf/pdf/ops'
import type {
  ExportImagesRequest,
  ExportImagesResult,
  ExtractPagesRequest,
  ExtractPagesResult,
  InsertPdfRequest,
  InsertPdfResult,
  PdfApi,
  SavePdfRequest,
  SavePdfResult,
} from '../apps/pdf/shared/ipc'
import { createAiBridge } from './ai-stream'
import { isTauri, platform } from './platform'

const LANG_KEY = 'panoffice.lang'

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

// ---- pending open path (#/pdf?src=…) ----

let pendingConsumed = false

/** Take the pdf path queued for this view (the shell routes `#/pdf?src=…`); null afterwards */
function consumePending(): Promise<string | null> {
  if (pendingConsumed) return Promise.resolve(null)
  pendingConsumed = true
  const query = window.location.hash.split('?')[1] ?? ''
  return Promise.resolve(new URLSearchParams(query).get('src'))
}

// ---- save / extract / insert / export ----

async function save(request: SavePdfRequest): Promise<SavePdfResult> {
  try {
    const bytes = await platform.readFile(request.path)
    const out = await applySaveRequest(bytes, request)
    await platform.writeFile(request.path, out)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errMsg(err) }
  }
}

/** Trigger a browser download for bytes (a[download]); Tauri path goes through dialogs instead */
function triggerDownload(fileName: string, bytes: Uint8Array, mime: string): void {
  const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

async function extractPages(request: ExtractPagesRequest): Promise<ExtractPagesResult> {
  try {
    const bytes = await platform.readFile(request.path)
    const out = await extractPagesBytes(bytes, request.pages)
    if (isTauri()) {
      // TODO(M3): native save dialog (tauri plugin-dialog) + write to the picked path
      return { ok: false, error: 'extractPages save dialog not implemented on tauri yet' }
    }
    // Browser fallback: download the bytes AND persist under the suggested
    // name in the overlay so the extracted file is reopenable in-session.
    triggerDownload(request.suggestedName, out, 'application/pdf')
    await platform.writeFile(request.suggestedName, out)
    return { ok: true, savedPath: request.suggestedName }
  } catch (err) {
    return { ok: false, error: errMsg(err) }
  }
}

/** Browser file picker standing in for the native open dialog (resolves null on cancel) */
function pickPdfFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/pdf'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.oncancel = () => resolve(null)
    input.click()
  })
}

async function insertPdf(request: InsertPdfRequest): Promise<InsertPdfResult> {
  if (isTauri()) {
    // TODO(M3): native open dialog (tauri plugin-dialog) for the pdf to merge in
    return { ok: false, error: 'not implemented on tauri yet' }
  }
  try {
    const file = await pickPdfFile()
    if (!file) return { ok: true, canceled: true }
    const bytes = await platform.readFile(request.path)
    const other = new Uint8Array(await file.arrayBuffer())
    const { merged, count } = await insertPdfBytes(bytes, other, request.afterPageIndex)
    await platform.writeFile(request.path, merged)
    return { ok: true, insertedCount: count }
  } catch (err) {
    return { ok: false, error: errMsg(err) }
  }
}

async function exportImages(request: ExportImagesRequest): Promise<ExportImagesResult> {
  if (request.images.length === 0) return { ok: false, error: 'pdf: no images' }
  if (isTauri()) {
    // TODO(M3): native directory picker (tauri plugin-dialog) + write each PNG
    return { ok: false, error: 'not implemented on tauri yet' }
  }
  try {
    // Same file naming as the upstream main handler: <base>-p<pageNo>.png
    const safeBase = String(request.baseName || 'page').replace(/[/\\:*?"<>|]/g, '_')
    for (const [i, b64] of request.images.entries()) {
      const no = request.pageNumbers[i] ?? i + 1
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j)
      triggerDownload(`${safeBase}-p${no}.png`, bytes, 'image/png')
    }
    return { ok: true, savedDir: 'downloads', count: request.images.length }
  } catch (err) {
    return { ok: false, error: errMsg(err) }
  }
}

// ---- close handshake / dirty mirror (stubs until M3 window lifecycle) ----

function setDirty(dirty: boolean): void {
  console.debug('[pdf-api] setDirty (stub):', dirty)
}

function onCloseSaveRequest(_handler: () => void): () => void {
  // The close prompt belongs to the real window lifecycle (M3); there is no
  // host event to subscribe to yet. Return an unsubscribe for API parity.
  console.debug('[pdf-api] onCloseSaveRequest registered (stub)')
  return () => {}
}

function sendCloseSaveResult(ok: boolean): void {
  console.debug('[pdf-api] sendCloseSaveResult (stub):', ok)
}

// ---- language ----

function getLanguage(): Promise<Lang> {
  const stored = localStorage.getItem(LANG_KEY)
  const lang = (LANGS as readonly string[]).includes(stored ?? '') ? (stored as Lang) : 'en'
  return Promise.resolve(lang)
}

// No language switcher in the shell yet, so handlers never fire; kept for API parity.
const languageHandlers = new Set<(lang: Lang) => void>()

function onLanguageChanged(handler: (lang: Lang) => void): () => void {
  languageHandlers.add(handler)
  return () => languageHandlers.delete(handler)
}

// ---- AI (direct in-webview streaming; no Electron transport) ----
// Shared with the docs bridge: see ./ai-stream.ts (settings + stream fan-out).

/** Install window.pdfApi. Called once by installBridge() before any renderer code runs. */
export function installPdfApi(): void {
  const ai = createAiBridge()
  const api: PdfApi = {
    consumePending,
    readFile: (path) => platform.readFile(path).then(toArrayBuffer),
    save,
    extractPages,
    insertPdf,
    exportImages,
    setDirty,
    onCloseSaveRequest,
    sendCloseSaveResult,
    getLanguage,
    onLanguageChanged,
    getAiSettings: ai.getAiSettings,
    aiStream: ai.aiStream,
    aiStreamCancel: ai.aiStreamCancel,
    onAiStream: ai.onAiStream,
  }
  window.pdfApi = api
}
