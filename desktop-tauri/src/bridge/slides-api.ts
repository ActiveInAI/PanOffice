/**
 * window.slidesApi — the slides editor's host surface, ported from the
 * Electron preload + main handlers (desktop/apps/slides/src/{preload,main})
 * onto the Tauri shell.
 *
 * What runs where after the port (see docs/TAURI-MIGRATION.md — the editing
 * kernel stays in TypeScript in the webview):
 *  - all ~110 document-editing ops (open/session/history/save included) run in
 *    the webview host: src/apps/slides/main/slides-host.ts, driving the
 *    source-aliased @genoffice/pptx-engine (Buffer/zlib shimmed for the
 *    browser build — see ./node-shims/),
 *  - raw file IO crosses into Rust (or the browser byte-store overlay, see
 *    ./platform.ts); system font enumeration is the Rust `list_fonts` command
 *    (consumed by src/apps/slides/main/fonts.ts),
 *  - AI settings/streaming reuse the shared in-webview bridge (./ai-stream.ts),
 *  - what has no webview analog is an honest stub with a TODO, same policy as
 *    the docs/sheets ports: the dual-screen presenter window (needs a second
 *    Tauri window), gsk login + web/image search + cloud generation (need a
 *    Rust-side network proxy), native dialogs/menus and the close guard (M3/M4
 *    shell lifecycle), print/PDF export (printToPDF has no Tauri equivalent),
 *    getPathForFile lives on window.desktop (installed by ./desktop-api).
 *
 * window.desktop (files subset) and window.projectApi are already installed by
 * ./desktop-api.ts — the slides renderer uses exactly that subset, so this
 * shim only adds window.slidesApi.
 */
import './node-shims/buffer'
import type { GenSparkAccountStatus } from '@genoffice/ai-provider'
import { LANGS } from '@genoffice/i18n'
import { createSlidesHost } from '../apps/slides/main/slides-host'
import type {
  AiStreamChunk,
  MenuCommand,
  OpenResult,
  ShowInkEvent,
  ShowSyncState,
  SlidesApi,
} from '../apps/slides/shared/ipc'
import { createAiBridge } from './ai-stream'

const LANG_KEY = 'panoffice.lang'
const STYLE_TEMPLATES_KEY = 'panoffice.slides.styleTemplates'

/** #/slides?src=… is consumed once per page load (same contract as the docs port) */
let pendingConsumed = false

/** Prepare the single-use route source before the shell mounts a new Slides view. */
export function resetPendingSlidesSource(): void {
  pendingConsumed = false
}

type SlidesLang = 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar'

function getLanguage(): Promise<SlidesLang> {
  const stored = localStorage.getItem(LANG_KEY)
  const lang = (LANGS as readonly string[]).includes(stored ?? '') ? (stored as SlidesLang) : 'zh'
  return Promise.resolve(lang)
}

// No language switcher in the shell yet, so handlers never fire; kept for API parity.
const languageHandlers = new Set<(lang: SlidesLang) => void>()

function onLanguageChanged(handler: (lang: SlidesLang) => void): () => void {
  languageHandlers.add(handler)
  return () => languageHandlers.delete(handler)
}

// ---- style templates (upstream: userData/style-templates/*.json; here localStorage) ----

interface StyleTemplate {
  name: string
  topic: string
  styleSkill: string
  createdAt: string
}

function readStyleTemplates(): StyleTemplate[] {
  try {
    const raw = localStorage.getItem(STYLE_TEMPLATES_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? (list as StyleTemplate[]) : []
  } catch {
    return []
  }
}

function saveStyleTemplate(
  name: string,
  data: { topic: string; styleSkill: string; createdAt: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const list = readStyleTemplates().filter((t) => t.name !== name)
    list.push({ name, ...data })
    localStorage.setItem(STYLE_TEMPLATES_KEY, JSON.stringify(list))
    return Promise.resolve({ ok: true })
  } catch (err) {
    return Promise.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

function listStyleTemplates(): Promise<Array<{ name: string; topic: string; createdAt: string }>> {
  return Promise.resolve(
    readStyleTemplates().map(({ name, topic, createdAt }) => ({ name, topic, createdAt })),
  )
}

function loadStyleTemplate(
  name: string,
): Promise<{ ok: boolean; styleSkill?: string; topic?: string; error?: string }> {
  const hit = readStyleTemplates().find((t) => t.name === name)
  if (!hit) return Promise.resolve({ ok: false, error: `style template not found: ${name}` })
  return Promise.resolve({ ok: true, styleSkill: hit.styleSkill, topic: hit.topic })
}

/** Upstream writes a <draft>.style.json sidecar next to the AI draft file; the deck itself carries the topic, so a no-op ack with a log is honest here. */
function saveStyleSidecar(data: {
  topic: string
  styleSkill: string
  createdAt: string
}): Promise<{ ok: boolean }> {
  // TODO(M4): persist next to the draft once the shell has real document paths
  console.debug('[slides-api] saveStyleSidecar (localStorage-only port):', data.topic)
  return Promise.resolve({ ok: true })
}

// ---- gsk / search stubs (need a Rust-side network proxy, TODO M3/M4) ----

function aiGskStatus(_withEmail?: boolean): Promise<GenSparkAccountStatus> {
  // PanOffice runs on PanAI — there is no Genspark account in this product,
  // so error handling must never offer the upstream sign-in call to action.
  return Promise.resolve({ loggedIn: true })
}

function aiGskLogin(): Promise<void> {
  console.debug('[slides-api] aiGskLogin (stub, TODO M3)')
  return Promise.resolve()
}

function gskStatus(): Promise<{ available: boolean; email?: string }> {
  return Promise.resolve({ available: false })
}

function webSearch(
  _query: string,
  _maxResults?: number,
): Promise<{
  results: Array<{ title: string; url: string; snippet: string }>
  answer?: string
  method: string
}> {
  return Promise.resolve({ results: [], method: 'error', error: 'web search unavailable (TODO M3)' })
}

function imageSearch(
  _query: string,
  _maxResults?: number,
): Promise<{
  images: Array<{
    title: string
    imageUrl: string
    sourceUrl: string
    source: string
    width?: number
    height?: number
  }>
  method: string
}> {
  return Promise.resolve({
    images: [],
    method: 'error',
    error: 'image search unavailable (TODO M3)',
  })
}

function generateImage(_op: {
  prompt: string
  model?: string
  referenceImageUrls?: string[]
  aspectRatio?: string
  imageSize?: string
}): Promise<{ url?: string; error?: string }> {
  return Promise.resolve({ error: 'image generation unavailable (needs gsk proxy, TODO M3)' })
}

function analyzeMedia(_op: {
  mediaUrls: string[]
  requirements: string
}): Promise<{ text?: string; error?: string }> {
  return Promise.resolve({ error: 'media analysis unavailable (needs gsk proxy, TODO M3)' })
}

// ---- presenter / dual-screen stubs (needs a second Tauri window, TODO M4) ----

const PRESENTER_TODO = 'presenter dual-screen mode needs a second Tauri window (TODO M4)'

function presenterStart(): Promise<{ audience: boolean }> {
  console.debug(`[slides-api] presenterStart (stub): ${PRESENTER_TODO}`)
  return Promise.resolve({ audience: false })
}

function presenterSwap(): Promise<boolean> {
  console.debug(`[slides-api] presenterSwap (stub): ${PRESENTER_TODO}`)
  return Promise.resolve(false)
}

function presenterEnd(): Promise<void> {
  console.debug(`[slides-api] presenterEnd (stub): ${PRESENTER_TODO}`)
  return Promise.resolve()
}

function audienceReady(): Promise<ShowSyncState | null> {
  return Promise.resolve(null)
}

/** Install window.slidesApi. Called once by installBridge() before any renderer code runs. */
export function installSlidesApi(): void {
  const host = createSlidesHost()
  const ai = createAiBridge()

  // Host → renderer pushes (upstream: webContents.send channels; here plain
  // in-realm subscriptions — no shell pushes these yet, see TODOs)
  const openedHandlers = new Set<(result: OpenResult) => void>()
  const renamedHandlers = new Set<(newPath: string) => void>()
  host.onOpened = (result) => {
    for (const h of openedHandlers) h(result)
  }
  host.onRenamed = (newPath) => {
    for (const h of renamedHandlers) h(newPath)
  }

  const api: SlidesApi = {
    getLanguage,
    onLanguageChanged,
    // ---- document session (host) ----
    openPptx: (fitWidthPx) => host.openPptx(fitWidthPx),
    openPptxPath: (path, fitWidthPx) => host.openPptxPath(path, fitWidthPx),
    consumePendingOpen: (fitWidthPx) => {
      // The shell routes #/slides?src=…; consumed once like the docs/sheets ports
      if (pendingConsumed) return Promise.resolve(null)
      pendingConsumed = true
      const query = window.location.hash.split('?')[1] ?? ''
      const src = new URLSearchParams(query).get('src')
      return host.consumePendingOpen(src, fitWidthPx)
    },
    newBlank: (fitWidthPx) => host.newBlank(fitWidthPx),
    htmlToPptx: (pagesHtml, fitWidthPx, mode, atIndex, deckName) =>
      host.htmlToPptx(pagesHtml, fitWidthPx, mode, atIndex, deckName),
    cloudGenStatus: () => host.cloudGenStatus(),
    cloudGeneratePage: (op) => host.cloudGeneratePage(op),
    // ---- editing ops (host) ----
    editText: (op) => host.editText(op),
    setElementFont: (op) => host.setElementFont(op),
    setElementParagraphFormat: (op) => host.setElementParagraphFormat(op),
    findReplace: (op) => host.findReplace(op),
    setSlideLayout: (op) => host.setSlideLayout(op),
    setSlideSize: (op) => host.setSlideSize(op),
    getSlideSize: () => host.getSlideSize(),
    editTransform: (op) => host.editTransform(op),
    editConnectorEndpoints: (op) => host.editConnectorEndpoints(op),
    editPictureSrcRect: (op) => host.editPictureSrcRect(op),
    editPictureOpacity: (op) => host.editPictureOpacity(op),
    editImageFill: (op) => host.editImageFill(op),
    setTextAnchor: (op) => host.setTextAnchor(op),
    clipboardExternal: () => host.clipboardExternal(),
    groupElements: (op) => host.groupElements(op),
    ungroupElement: (op) => host.ungroupElement(op),
    batchEditTransform: (op) => host.batchEditTransform(op),
    getRenderSlides: () => host.getRenderSlides(),
    addElement: (op) => host.addElement(op),
    deleteElement: (op) => host.deleteElement(op),
    addSlide: (op) => host.addSlide(op),
    addBlankSlide: (op) => host.addBlankSlide(op),
    addSlideWithLayout: (op) => host.addSlideWithLayout(op),
    getLayouts: () => host.getLayouts(),
    masterEnter: (fitWidthPx) => host.masterEnter(fitWidthPx),
    masterOpen: (partPath) => host.masterOpen(partPath),
    masterClose: () => host.masterClose(),
    masterEditText: (op) => host.masterEditText(op),
    masterEditTransform: (op) => host.masterEditTransform(op),
    masterEditFill: (op) => host.masterEditFill(op),
    masterEditStroke: (op) => host.masterEditStroke(op),
    masterDeleteElement: (op) => host.masterDeleteElement(op),
    editFill: (op) => host.editFill(op),
    editStroke: (op) => host.editStroke(op),
    flipElements: (op) => host.flipElements(op),
    editBackground: (op) => host.editBackground(op),
    insertImage: (slideIndex, fitWidthPx) => host.insertImage(slideIndex, fitWidthPx),
    copySlide: (slideIndex, pngBase64) => host.copySlide(slideIndex, pngBase64),
    pasteSlide: (op) => host.pasteSlide(op),
    repasteSlide: (op) => host.repasteSlide(op),
    hasSlideClipboard: () => host.hasSlideClipboard(),
    deleteSlide: (slideIndex) => host.deleteSlide(slideIndex),
    reorderElement: (op) => host.reorderElement(op),
    editTableCell: (op) => host.editTableCell(op),
    tableStructure: (op) => host.tableStructure(op),
    tableMerge: (op) => host.tableMerge(op),
    setTableColWidth: (op) => host.setTableColWidth(op),
    setTableRowHeight: (op) => host.setTableRowHeight(op),
    setTableCellAnchor: (op) => host.setTableCellAnchor(op),
    editTableStyle: (op) => host.editTableStyle(op),
    editChart: (op) => host.editChart(op),
    getChartColorSchemes: () => host.getChartColorSchemes(),
    getChartData: (slideIndex, sourceId) => host.getChartData(slideIndex, sourceId),
    copyElements: (op) => host.copyElements(op),
    pasteElements: (op) => host.pasteElements(op),
    duplicateElements: (op) => host.duplicateElements(op),
    addTable: (op) => host.addTable(op),
    addInk: (op) => host.addInk(op),
    addChart: (op) => host.addChart(op),
    addSmartArt: (op) => host.addSmartArt(op),
    addImageBytes: (op) => host.addImageBytes(op),
    insertMedia: (slideIndex, kind, fitWidthPx) => host.insertMedia(slideIndex, kind, fitWidthPx),
    addMediaBytes: (op) => host.addMediaBytes(op),
    getMediaData: (slideIndex, sourceId) => host.getMediaData(slideIndex, sourceId),
    insertModel3d: (slideIndex, fitWidthPx) => host.insertModel3d(slideIndex, fitWidthPx),
    setLink: (op) => host.setLink(op),
    getLink: (slideIndex, sourceId) => host.getLink(slideIndex, sourceId),
    getSlideLinks: (slideIndex) => host.getSlideLinks(slideIndex),
    getRunLinks: (slideIndex) => host.getRunLinks(slideIndex),
    applyHeaderFooter: (op) => host.applyHeaderFooter(op),
    getHeaderFooter: (slideIndex) => host.getHeaderFooter(slideIndex),
    applyTheme: (op) => host.applyTheme(op),
    setTransition: (op) => host.setTransition(op),
    getTransition: (slideIndex) => host.getTransition(slideIndex),
    setAdvanceTimes: (op) => host.setAdvanceTimes(op),
    getAnimations: (slideIndex) => host.getAnimations(slideIndex),
    getShapeKeys: (slideIndex) => host.getShapeKeys(slideIndex),
    setAnimations: (op) => host.setAnimations(op),
    setSlideHidden: (op) => host.setSlideHidden(op),
    getSections: () => host.getSections(),
    setSections: (sections) => host.setSections(sections),
    addSection: (op) => host.addSection(op),
    renameSection: (op) => host.renameSection(op),
    removeSection: (op) => host.removeSection(op),
    moveSection: (op) => host.moveSection(op),
    moveSlide: (op) => host.moveSlide(op),
    getNotes: (slideIndex) => host.getNotes(slideIndex),
    setNotes: (op) => host.setNotes(op),
    getComments: (slideIndex) => host.getComments(slideIndex),
    addComment: (op) => host.addComment(op),
    deleteComment: (op) => host.deleteComment(op),
    nativeClipboard: (op) => host.nativeClipboard(op),
    beginHistoryBatch: () => host.beginHistoryBatch(),
    endHistoryBatch: () => host.endHistoryBatch(),
    aiSnapshotRestore: (id) => host.aiSnapshotRestore(id),
    undo: () => host.undo(),
    redo: () => host.redo(),
    // ---- export / print / save ----
    pickExportDir: () => host.pickExportDir(),
    exportImages: (op) => host.exportImages(op),
    pickExportPdfPath: (defaultName) => host.pickExportPdfPath(defaultName),
    exportPdf: (op) => host.exportPdf(op),
    printSlides: (op) => host.printSlides(op),
    save: () => host.save(),
    saveAs: (defaultName) => host.saveAs(defaultName),
    // ---- close guard (no window lifecycle in the shell yet, TODO M3) ----
    onCloseSaveRequest: (_handler) => () => {},
    reportCloseSaveResult: (ok) => {
      console.debug('[slides-api] reportCloseSaveResult (stub):', ok)
    },
    setAutoSavePref: (on) => host.setAutoSavePref(on),
    isDirty: () => host.isDirty(),
    getRecentFiles: () => host.getRecentFiles(),
    // ---- shell events (nothing pushes these yet, TODO M3/M4) ----
    onMenuCommand: (_handler: (command: MenuCommand) => void) => {
      // TODO(M3): tauri plugin-menu events; Ctrl+S/Ctrl+O still work via the
      // renderer's own keydown handler, so basic editing UX is intact
      return () => {}
    },
    onOpened: (handler) => {
      openedHandlers.add(handler)
      return () => openedHandlers.delete(handler)
    },
    onRenamed: (handler) => {
      renamedHandlers.add(handler)
      return () => renamedHandlers.delete(handler)
    },
    // ---- AI (shared in-webview bridge + stubs) ----
    getAiSettings: ai.getAiSettings,
    setAiSettings: ai.setAiSettings,
    aiStream: ai.aiStream,
    aiStreamCancel: ai.aiStreamCancel,
    aiGskStatus,
    aiGskLogin,
    webSearch,
    imageSearch,
    insertImageUrl: (op) => host.insertImageUrl(op),
    generateImage,
    analyzeMedia,
    gskStatus,
    onAiStream: ai.onAiStream,
    saveStyleSidecar,
    saveStyleTemplate,
    listStyleTemplates,
    loadStyleTemplate,
    // ---- presenter / dual-screen (stubs, TODO M4) ----
    presenterStart,
    presenterSync: (_state: ShowSyncState) => {
      console.debug('[slides-api] presenterSync (stub)')
    },
    presenterInk: (_ev: ShowInkEvent) => {
      console.debug('[slides-api] presenterInk (stub)')
    },
    presenterSwap,
    presenterEnd,
    audienceReady,
    audienceNav: (_action) => {
      console.debug('[slides-api] audienceNav (stub)')
    },
    onShowSync: (_handler) => () => {},
    onShowInk: (_handler) => () => {},
    onAudienceNav: (_handler) => () => {},
  }
  window.slidesApi = api
}
