/**
 * window.desktop + window.projectApi — the docs editor's host surface, ported
 * from the Electron preload + main handlers (desktop/apps/docs/src/{preload,main})
 * onto the Tauri shell.
 *
 * Everything that was pure JS upstream (docx-engine paragraph-patch save) runs
 * in the webview here; only raw file IO crosses into Rust (or the browser
 * byte-store overlay, see ./platform.ts). Method semantics follow
 * desktop/apps/docs/src/main/docs-main.ts. What has no webview analog is an
 * honest stub with a TODO instead of a silent no-op:
 *  - print → window.print(); exportPdf/printPdfBuffer/saveMergedPdf →
 *    {ok:false}: printToPDF has no Tauri equivalent — needs the Rust printpdf
 *    path (M3 decision, see docs/TAURI-MIGRATION.md §4),
 *  - native dialogs/menus/tabs/close handshake → M3 (tauri plugin-dialog /
 *    plugin-menu / real window lifecycle),
 *  - gsk login + web/image search → need a Rust-side network proxy (M3),
 *  - getPathForFile → null (no webUtils; Tauri drag-drop event later).
 */
import type { GenSparkAccountStatus } from '@genoffice/ai-provider'
import { LANGS } from '@genoffice/i18n'
import type { ChatMessage, ProjectApi, ProjectSummary, TimelineEntry } from '@genoffice/project-store'
import type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentMeta,
  AttachmentReadResult,
  DesktopApi,
  DocsTabInfo,
  MenuCommand,
  OpenFileResult,
  PickImageResult,
} from '../apps/docs/shared/ipc'
import { ATTACHMENT_IMAGE_EXTS } from '../apps/docs/shared/ipc'
import { wopiDisplayName } from '../server-files'
import { createAiBridge } from './ai-stream'
import { isTauri, platform } from './platform'

const LANG_KEY = 'panoffice.lang'
const RECENT_KEY = 'panoffice.docs.recent'
/** Same cap as the upstream main process (recent.json) */
const RECENT_LIMIT = 100
/** Same caps as the upstream attachment handlers (docs-main.ts) */
const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** Overlay key prefix for attachment bytes picked/pasted in-session */
const ATTACHMENT_DIR = 'attachments'
/** Overlay key prefix for crash-recovery copies (never shadows the real path) */
const RECOVERY_PREFIX = '__recovery__/'
/** Where a new document's first silent save lands (upstream: <Documents>/GenOffice) */
const DEFAULT_SAVE_DIR = 'Documents/GenOffice'

/** plain-text extensions read as UTF-8 (same list as upstream docs-main.ts) */
const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'log',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'c',
  'h',
  'cpp',
  'go',
  'rs',
  'rb',
  'sh',
  'sql',
  'css',
])
/** office/pdf formats get text extracted Rust-side via @genoffice/file-parse (TODO M3) */
const ATTACHMENT_EXTS = new Set([
  ...TEXT_EXTS,
  'docx',
  'pdf',
  'pptx',
  'ppt',
  'xlsx',
  'xls',
  ...ATTACHMENT_IMAGE_EXTS,
])

const ATTACHMENT_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

const IMAGE_MIME: Record<string, 'image/png' | 'image/jpeg' | 'image/gif'> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Display name for a path or URL: basename minus query; a WOPI …/<name>/contents?… URL yields the decoded <name>. */
const displayName = (path: string): string => {
  const wopi = wopiDisplayName(path)
  if (wopi !== null) return wopi
  const parts = (path.split(/[?#]/)[0] ?? '').split(/[\\/]/).filter((p) => p.length > 0)
  return parts[parts.length - 1] ?? basename(path)
}

const extOf = (name: string): string => name.split('.').pop()?.toLowerCase() ?? ''

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** sha256 (hex) of file bytes — upstream archives originals under this hash */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes))
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    // non-secure context (no crypto.subtle): content addressing degrades to a
    // plain checksum — the renderer only stores the value, never verifies it
    let h1 = 0x811c9dc5
    let h2 = 0x01000193
    for (const b of bytes) {
      h1 = Math.imul(h1 ^ b, 0x01000193)
      h2 = Math.imul(h2 ^ b, 0x85ebca6b)
    }
    return `fnv-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
  }
}

// ---- recent files (localStorage stands in for userData/recent.json) ----

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

/** Same ordering/skip logic as the upstream pushRecent (docs-main.ts) */
function pushRecent(path: string): void {
  const recent = readRecents()
  if (recent[0] === path) return
  localStorage.setItem(
    RECENT_KEY,
    JSON.stringify([path, ...recent.filter((p) => p !== path)].slice(0, RECENT_LIMIT)),
  )
}

// ---- document open/save ----

/** paths the renderer may overwrite via saveDocx — populated by open/save-as flows */
const docWritablePaths = new Set<string>()

async function loadDocx(path: string): Promise<OpenFileResult | null> {
  // Remote WOPI contents URLs carry the extension mid-path: /wopi/files/<name>.docx/contents?access_token=…
  if (typeof path !== 'string' || !/\.docx([/?#]|$)/i.test(path)) return null
  try {
    const bytes = await platform.readFile(path)
    const hash = await sha256Hex(bytes)
    pushRecent(path)
    docWritablePaths.add(path)
    // TODO(M3): crash-recovery restore prompt — upstream compares the recovery
    // copy's mtime against the original and offers Restore/Discard; the overlay
    // tracks no mtimes and the dialog is native.
    return { path, name: displayName(path), data: toArrayBuffer(bytes), hash }
  } catch {
    return null
  }
}

// ---- pending open path (#/docs?src=…) ----

let pendingConsumed = false

/** Prepare the single-use route source before the shell mounts a new Docs view. */
export function resetPendingDocumentSource(): void {
  pendingConsumed = false
}

/** Take the docx path queued for this view (the shell routes `#/docs?src=…`); null afterwards */
function consumePendingOpenDocx(): Promise<OpenFileResult | null> {
  if (pendingConsumed) return Promise.resolve(null)
  pendingConsumed = true
  const query = window.location.hash.split('?')[1] ?? ''
  const src = new URLSearchParams(query).get('src')
  return src ? loadDocx(src) : Promise.resolve(null)
}

/** No shell tab spawns "New Document" yet; consumed once so a later flag can't leak */
let newBlankConsumed = false

function consumeNewBlankDoc(): Promise<boolean> {
  // TODO(M3): real new-blank tab flow when the shell spawns docs views itself
  if (newBlankConsumed) return Promise.resolve(false)
  newBlankConsumed = true
  return Promise.resolve(false)
}

/** Browser file picker standing in for the native open dialog (resolves null on cancel) */
function pickFile(accept: string, multiple = false): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.onchange = () => resolve(input.files)
    input.oncancel = () => resolve(null)
    input.click()
  })
}

/** Open via picker: bytes land in the overlay under the file name so the doc is reopenable in-session */
async function openDocx(): Promise<OpenFileResult | null> {
  // TODO(M3): native open dialog (tauri plugin-dialog) returning a real path
  const files = await pickFile('.docx')
  const file = files?.[0]
  if (!file) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  await platform.writeFile(file.name, bytes)
  return loadDocx(file.name)
}

function openDocxPath(path: string): Promise<OpenFileResult | null> {
  return loadDocx(path)
}

async function saveDocx(path: string, data: ArrayBuffer): Promise<{ ok: boolean; error?: string }> {
  try {
    // only paths the user opened or chose via save-as may be overwritten
    if (typeof path !== 'string' || !docWritablePaths.has(path)) {
      return { ok: false, error: 'save target is not an opened document' }
    }
    await platform.writeFile(path, new Uint8Array(data))
    await platform.deleteFile(RECOVERY_PREFIX + path)
    pushRecent(path)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errMsg(err) }
  }
}

/** crash-recovery copy of a dirty document; best-effort, never surfaces */
async function writeRecoveryCopy(path: string, data: ArrayBuffer): Promise<{ ok: boolean }> {
  if (isTauri()) {
    // TODO(M3): real recovery dir under appDataDir via a Rust command
    return { ok: false }
  }
  try {
    if (typeof path !== 'string' || !docWritablePaths.has(path)) return { ok: false }
    await platform.writeFile(RECOVERY_PREFIX + path, new Uint8Array(data))
    return { ok: true }
  } catch {
    return { ok: false }
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

async function saveDocxAs(
  defaultName: string,
  data: ArrayBuffer,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (isTauri()) {
    // TODO(M3): native save dialog (tauri plugin-dialog) + write to the picked path
    return { ok: false, error: 'saveDocxAs dialog not implemented on tauri yet' }
  }
  try {
    const bytes = new Uint8Array(data)
    // Browser fallback: download the bytes AND persist under the chosen name in
    // the overlay so the saved-as file is reopenable in-session.
    triggerDownload(defaultName, bytes, DOCX_MIME)
    await platform.writeFile(defaultName, bytes)
    docWritablePaths.add(defaultName)
    pushRecent(defaultName)
    return { ok: true, path: defaultName }
  } catch (err) {
    return { ok: false, error: errMsg(err) }
  }
}

/** first save of a new document: silently lands in the default folder, no dialog */
async function saveDocxNew(
  defaultName: string,
  data: ArrayBuffer,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    // uniquePathIn semantics: name.ext, name-2.ext, name-3.ext…
    const dot = defaultName.lastIndexOf('.')
    const base = dot > 0 ? defaultName.slice(0, dot) : defaultName
    const ext = dot > 0 ? defaultName.slice(dot) : ''
    let candidate = `${DEFAULT_SAVE_DIR}/${defaultName}`
    for (let i = 2; await platform.exists(candidate); i++) {
      candidate = `${DEFAULT_SAVE_DIR}/${base}-${i}${ext}`
    }
    await platform.writeFile(candidate, new Uint8Array(data))
    docWritablePaths.add(candidate)
    pushRecent(candidate)
    return { ok: true, path: candidate }
  } catch (err) {
    return { ok: false, error: errMsg(err) }
  }
}

function getRecentFiles(): Promise<string[]> {
  // TODO(M3): filter by existence once the Rust backend can stat
  return Promise.resolve(readRecents())
}

async function pickImage(): Promise<PickImageResult | null> {
  // TODO(M3): native open dialog (tauri plugin-dialog)
  const files = await pickFile('.png,.jpg,.jpeg,.gif')
  const file = files?.[0]
  if (!file) return null
  const mime = IMAGE_MIME[extOf(file.name)]
  if (!mime) return null
  return { base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())), mime, name: file.name }
}

// ---- print / export PDF ----

function print(): Promise<void> {
  window.print()
  return Promise.resolve()
}

const PDF_EXPORT_TODO =
  'PDF export needs the Rust printpdf path — M3 decision, see docs/TAURI-MIGRATION.md §4'

function exportPdf(): Promise<{ ok: boolean; path?: string; error?: string }> {
  return Promise.resolve({ ok: false, error: PDF_EXPORT_TODO })
}

function printPdfBuffer(): Promise<{ ok: boolean; base64?: string; error?: string }> {
  return Promise.resolve({ ok: false, error: PDF_EXPORT_TODO })
}

function saveMergedPdf(): Promise<{ ok: boolean; path?: string; error?: string }> {
  return Promise.resolve({ ok: false, error: PDF_EXPORT_TODO })
}

// ---- Genspark login / web search (need a Rust-side network proxy, M3) ----

function aiGskStatus(_withEmail?: boolean): Promise<GenSparkAccountStatus> {
  // PanOffice runs on PanAI — there is no Genspark account in this product,
  // so error handling must never offer the upstream sign-in call to action.
  return Promise.resolve({ loggedIn: true })
}

function aiGskLogin(): Promise<void> {
  // TODO(M3): upstream opens the system browser for the OAuth flow
  console.debug('[desktop-api] aiGskLogin (stub, TODO M3)')
  return Promise.resolve()
}

function webSearch(
  _query: string,
  _maxResults?: number,
): Promise<{
  results: Array<{ title: string; url: string; snippet: string }>
  answer?: string
  method: string
}> {
  // TODO(M3): DuckDuckGo/Serper are CORS-blocked in the webview — proxy Rust-side
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
  // TODO(M3): same CORS constraint as webSearch
  return Promise.resolve({
    images: [],
    method: 'error',
    error: 'image search unavailable (TODO M3)',
  })
}

/** Download an image URL → base64+mime; null on any failure (same contract as upstream) */
async function fetchImage(url: string): Promise<{ base64: string; mime: string } | null> {
  try {
    // same SSRF hygiene as upstream: http(s) only; CORS still applies in the webview
    if (!/^https?:\/\//i.test(url)) return null
    const resp = await fetch(url)
    if (!resp.ok) return null
    const bytes = new Uint8Array(await resp.arrayBuffer())
    const ct = resp.headers.get('content-type') ?? ''
    const mime = ct.includes('png') ? 'image/png' : ct.includes('gif') ? 'image/gif' : 'image/jpeg'
    return { base64: bytesToBase64(bytes), mime }
  } catch {
    return null
  }
}

// ---- chat attachments ----

let pastedImageSeq = 0

function statAttachment(path: string, sizeBytes: number): { meta?: AttachmentMeta; error?: string } {
  const name = basename(path)
  const ext = extOf(name)
  if (!ATTACHMENT_EXTS.has(ext)) return { error: `${name}: unsupported file type .${ext}` }
  if (sizeBytes > ATTACHMENT_MAX_BYTES) {
    return { error: `${name}: file too large (>${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB)` }
  }
  if (ATTACHMENT_IMAGE_EXTS.has(ext) && sizeBytes > ATTACHMENT_IMAGE_MAX_BYTES) {
    return { error: `${name}: image too large (>${Math.round(ATTACHMENT_IMAGE_MAX_BYTES / 1024 / 1024)}MB)` }
  }
  return { meta: { path, name, ext, sizeBytes } }
}

function collectAttachments(metas: AttachmentMeta[], rejected: string[]): AttachmentAddResult {
  return { accepted: metas, rejected }
}

async function pickAttachments(): Promise<AttachmentAddResult | null> {
  // TODO(M3): native multi-select dialog (tauri plugin-dialog) returning real paths
  const files = await pickFile('', true)
  if (!files || files.length === 0) return null
  const accepted: AttachmentMeta[] = []
  const rejected: string[] = []
  for (const file of Array.from(files)) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    // picked files have no local path in a webview; park the bytes in the
    // overlay and hand out the overlay key as the attachment path
    const path = `${ATTACHMENT_DIR}/${file.name}`
    const { meta, error } = statAttachment(path, bytes.byteLength)
    if (error) {
      rejected.push(error)
      continue
    }
    await platform.writeFile(path, bytes)
    accepted.push(meta!)
  }
  return collectAttachments(accepted, rejected)
}

async function addAttachmentPaths(paths: string[]): Promise<AttachmentAddResult> {
  const accepted: AttachmentMeta[] = []
  const rejected: string[] = []
  for (const path of paths) {
    try {
      const bytes = await platform.readFile(path)
      const { meta, error } = statAttachment(path, bytes.byteLength)
      if (meta) accepted.push(meta)
      else rejected.push(error!)
    } catch {
      rejected.push(`${basename(path)}: unreadable`)
    }
  }
  return collectAttachments(accepted, rejected)
}

async function addPastedImage(data: ArrayBuffer, ext: string): Promise<AttachmentAddResult> {
  const cleanExt = typeof ext === 'string' ? ext.toLowerCase() : ''
  const bytes = new Uint8Array(data)
  if (!ATTACHMENT_IMAGE_EXTS.has(cleanExt) || bytes.byteLength === 0) {
    return collectAttachments([], ['not an image'])
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const path = `${ATTACHMENT_DIR}/pasted-${stamp}-${++pastedImageSeq}.${cleanExt}`
  const { meta, error } = statAttachment(path, bytes.byteLength)
  if (!meta) return collectAttachments([], [error!])
  await platform.writeFile(path, bytes)
  return collectAttachments([meta], [])
}

async function readAttachment(
  path: string,
  offset: number,
  maxChars: number,
): Promise<AttachmentReadResult> {
  const name = basename(path)
  const ext = extOf(name)
  if (!ATTACHMENT_EXTS.has(ext)) return { ok: false, error: `unsupported file type .${ext}` }
  if (ATTACHMENT_IMAGE_EXTS.has(ext)) return { ok: false, error: 'image attachments have no text' }
  if (!TEXT_EXTS.has(ext)) {
    // docx/pdf/pptx/xlsx extraction runs on @genoffice/file-parse (node:fs) —
    // needs a Rust-side command, TODO M3
    return { ok: false, error: `.${ext} text extraction not available in the port yet (TODO M3)` }
  }
  try {
    const bytes = await platform.readFile(path)
    const text = new TextDecoder('utf-8').decode(bytes)
    const start = Math.max(0, Math.floor(offset) || 0)
    const size = Math.min(Math.max(1, Math.floor(maxChars) || 1), 48_000)
    return {
      ok: true,
      name,
      totalChars: text.length,
      offset: start,
      text: text.slice(start, start + size),
    }
  } catch (err) {
    return { ok: false, error: errMsg(err) }
  }
}

async function readAttachmentImage(path: string): Promise<AttachmentImageResult> {
  const name = basename(path)
  const mime = ATTACHMENT_IMAGE_MIME[extOf(name)]
  if (!mime) return { ok: false, error: `${name}: not an image` }
  try {
    const bytes = await platform.readFile(path)
    if (bytes.byteLength > ATTACHMENT_IMAGE_MAX_BYTES) {
      return { ok: false, error: `${name}: image too large` }
    }
    return { ok: true, base64: bytesToBase64(bytes), mime }
  } catch {
    return { ok: false, error: `${name}: unreadable` }
  }
}

/** No webUtils in a Tauri webview — drag-dropped Files have no absolute path here */
function getPathForFile(_file: File): string | null {
  // TODO: use the Tauri drag-drop event (webview.onDragDropEvent) to recover real paths
  return null
}

// ---- tabs (single-window shell for now) ----

function openNewTab(_openPath?: string | null): Promise<void> {
  // TODO(M3): spawn a real docs tab/window once the shell has a tab strip
  console.debug('[desktop-api] openNewTab (stub, TODO M3)')
  return Promise.resolve()
}

function listDocsTabs(): Promise<DocsTabInfo[]> {
  return Promise.resolve([{ id: 'main', title: document.title, focused: true }])
}

function focusDocsTab(_id: string): Promise<void> {
  // single tab — nothing to focus; TODO(M3) with the tab strip
  return Promise.resolve()
}

// ---- events: menu commands / close handshake (no native host yet) ----

function onMenuCommand(_handler: (command: MenuCommand, payload?: string) => void): () => void {
  // TODO(M3): tauri plugin-menu events; Ctrl+S/Ctrl+O/etc. still work via the
  // renderer's own keydown handler, so basic editing UX is intact
  return () => {}
}

function onCloseCheck(_handler: () => void): () => void {
  // TODO(M3): real close guard with the window lifecycle
  return () => {}
}

function reportCloseCheck(state: { dirty: boolean; autoSave: boolean; filePath?: string | null }) {
  console.debug('[desktop-api] reportCloseCheck (stub):', state)
}

function onCloseSaveRequest(_handler: () => void): () => void {
  // TODO(M3): real close guard with the window lifecycle
  return () => {}
}

function reportCloseSaveResult(ok: boolean): void {
  console.debug('[desktop-api] reportCloseSaveResult (stub):', ok)
}

// ---- language ----

type DocsLang = 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar'

function getLanguage(): Promise<DocsLang> {
  const stored = localStorage.getItem(LANG_KEY)
  const lang = (LANGS as readonly string[]).includes(stored ?? '') ? (stored as DocsLang) : 'zh'
  return Promise.resolve(lang)
}

// No language switcher in the shell yet, so handlers never fire; kept for API parity.
const languageHandlers = new Set<(lang: DocsLang) => void>()

function onLanguageChanged(handler: (lang: DocsLang) => void): () => void {
  languageHandlers.add(handler)
  return () => languageHandlers.delete(handler)
}

// ---- window.projectApi: chat-history persistence over localStorage ----
//
// Upstream this is the node:fs-backed ProjectStore under userData (projects,
// JSONL chat logs). The docs renderer only uses the four chat methods (all
// failure-tolerant); those run fully here. The P1 project-management methods
// belong to the shell home screen and are minimal stubs until the home app is
// ported (TODO M3).

const CHAT_KEY = 'panoffice.docs.chats'

interface ChatStoreData {
  /** absolute path → stable chatId (history follows the file across reopens) */
  chatIdByPath: Record<string, string>
  chats: Record<string, ChatMessage[]>
}

function readChatStore(): ChatStoreData {
  try {
    const raw = localStorage.getItem(CHAT_KEY)
    const data: unknown = raw ? JSON.parse(raw) : null
    if (data && typeof data === 'object' && 'chats' in data) return data as ChatStoreData
  } catch {
    /* corrupted store: start clean */
  }
  return { chatIdByPath: {}, chats: {} }
}

function writeChatStore(data: ChatStoreData): void {
  localStorage.setItem(CHAT_KEY, JSON.stringify(data))
}

/** chatId for a file path: stable mapping first, derived from the path otherwise */
function chatIdForPath(store: ChatStoreData, path: string): string {
  const existing = store.chatIdByPath[path]
  if (existing) return existing
  let h = 0x811c9dc5
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193)
  const chatId = `chat-${(h >>> 0).toString(16).padStart(8, '0')}`
  store.chatIdByPath[path] = chatId
  return chatId
}

const projectApi: ProjectApi = {
  resolveChat(args) {
    const store = readChatStore()
    if (!args.filePath) {
      return Promise.resolve({
        projectId: 'default',
        chatId: args.tempChatId ?? `unsaved-${Date.now()}`,
      })
    }
    const chatId = chatIdForPath(store, args.filePath)
    writeChatStore(store)
    return Promise.resolve({ projectId: 'default', chatId })
  },
  appendChat(args) {
    const store = readChatStore()
    const msgs = (store.chats[args.chatId] ??= [])
    const msg: ChatMessage = {
      seq: (msgs[msgs.length - 1]?.seq ?? 0) + 1,
      ts: new Date().toISOString(),
      role: args.role,
      text: args.text,
    }
    if (args.tools) msg.tools = args.tools
    if (args.attachments) msg.attachments = args.attachments
    msgs.push(msg)
    writeChatStore(store)
    return Promise.resolve()
  },
  loadChat(args) {
    const store = readChatStore()
    const msgs = store.chats[args.chatId] ?? []
    return Promise.resolve(msgs.slice(-(args.limit ?? 200)))
  },
  rebindChat(args) {
    const store = readChatStore()
    if (args.newFilePath) {
      const chatId = chatIdForPath(store, args.newFilePath)
      if (chatId !== args.tempChatId && store.chats[args.tempChatId]) {
        // fold the temp history into the file's chat and drop the temp key
        store.chats[chatId] = [...(store.chats[chatId] ?? []), ...store.chats[args.tempChatId]]
        delete store.chats[args.tempChatId]
      }
      writeChatStore(store)
      return Promise.resolve({ projectId: args.projectId, chatId })
    }
    if (args.newChatId && args.newChatId !== args.tempChatId) {
      if (store.chats[args.tempChatId]) {
        store.chats[args.newChatId] = store.chats[args.tempChatId]
        delete store.chats[args.tempChatId]
      }
      writeChatStore(store)
    }
    return Promise.resolve({ projectId: args.projectId, chatId: args.newChatId ?? args.tempChatId })
  },
  // ── P1 extensions: shell home-screen features, not used by the docs
  // renderer — minimal stubs until the home app is ported (TODO M3) ──
  listProjects(): Promise<ProjectSummary[]> {
    const now = new Date().toISOString()
    return Promise.resolve([
      {
        id: 'default',
        name: 'default',
        createdAt: now,
        updatedAt: now,
        fileCount: 0,
        lastActiveAt: now,
        isDefault: true,
      },
    ])
  },
  createProject(): Promise<ProjectSummary> {
    return Promise.reject(new Error('project management not available in the port yet (TODO M3)'))
  },
  renameProject(): Promise<void> {
    return Promise.reject(new Error('project management not available in the port yet (TODO M3)'))
  },
  deleteProject(): Promise<void> {
    return Promise.reject(new Error('project management not available in the port yet (TODO M3)'))
  },
  moveFile(): Promise<void> {
    return Promise.resolve()
  },
  getTimeline(): Promise<TimelineEntry[]> {
    return Promise.resolve([])
  },
}

/** Install window.desktop + window.projectApi. Called once by installBridge() before any renderer code runs. */
export function installDesktopApi(): void {
  const ai = createAiBridge()
  const api: DesktopApi = {
    getLanguage,
    onLanguageChanged,
    openDocx,
    openDocxPath,
    consumePendingOpenDocx,
    consumeNewBlankDoc,
    // No host pushes documents to the view yet (Finder/Explorer "Open With",
    // shell home) — TODO(M3): emit from the shell when it routes files in
    onOpenDocx: (_handler) => () => {},
    onRenamedDocx: (_handler) => () => {},
    saveDocx,
    writeRecoveryCopy,
    saveDocxAs,
    saveDocxNew,
    getRecentFiles,
    pickImage,
    print,
    exportPdf,
    printPdfBuffer,
    saveMergedPdf,
    getAiSettings: ai.getAiSettings,
    setAiSettings: ai.setAiSettings,
    aiChat: ai.aiChat,
    aiStream: ai.aiStream,
    aiStreamCancel: ai.aiStreamCancel,
    aiGskStatus,
    aiGskLogin,
    webSearch,
    imageSearch,
    fetchImage,
    pickAttachments,
    addAttachmentPaths,
    addPastedImage,
    readAttachment,
    readAttachmentImage,
    getPathForFile,
    openNewTab,
    listDocsTabs,
    focusDocsTab,
    onAiStream: ai.onAiStream,
    onMenuCommand,
    onCloseCheck,
    reportCloseCheck,
    onCloseSaveRequest,
    reportCloseSaveResult,
  }
  window.desktop = api
  window.projectApi = projectApi
}
