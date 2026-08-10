/**
 * GenOffice Slides host — webview port of the Electron main process
 * (desktop/apps/slides/src/main/slides-main.ts). Handler logic is copied
 * verbatim; only the platform seams changed:
 *
 *  - node:fs → the bridge byte-store (platform.readFile/writeFile/exists/deleteFile);
 *    the browser overlay is flat, so mkdir is dropped and paths are plain strings.
 *  - node:crypto autosave keys: sha1 → sha256 (keys are opaque, the change is harmless).
 *  - Electron dialogs → in-webview pickers (<input type=file>), window.confirm for
 *    confirmations, console.warn + default-path proceed for informational modals
 *    (each marked TODO(M4): real modal dialog).
 *  - Recents live in localStorage ('panoffice.slides.recent') instead of userData JSON.
 *  - Single session (one slides editor per webview): upstream's sessions.get(e.sender.id)
 *    becomes this.session via requireSession().
 *  - No renderer events leave the host: upstream's wc.send/slidesOpenedHook surface as the
 *    optional onOpened/onRenamed callbacks; the close guard is bridge-level TODO(M4).
 *  - savePptxToFile needs node:fs and is never used here — savePptx + platform.writeFile.
 */
import {
  addChart,
  addElement,
  addMedia,
  addModel3d,
  addPicture,
  addSlideComment,
  addSmartArt,
  applyHeaderFooter,
  applyThemeToArchive,
  remapDeckColors,
  addTable,
  copyElementData,
  editPictureSrcRect,
  groupElements,
  ungroupElement,
  findGroupChild,
  editGroupChildTransform,
  patchGroupChildText,
  setGroupChildFont,
  editGroupChildFill,
  editGroupChildStroke,
  patchBodyPrAutofit,
  getElementLink,
  getSlideLinks,
  getRunLinks,
  ensureRunLinkRels,
  readHeaderFooter,
  setElementLink,
  createBlankPptx,
  deleteElement,
  deleteSlide,
  deleteSlideComment,
  duplicateSlide,
  copySlide,
  pasteSlide,
  type SlideBundle,
  insertBlankSlide,
  insertSlideWithLayout,
  listSlideLayouts,
  editTableCellText,
  editTableStructure,
  editTableStyle,
  ensureTableStylePart,
  editChartElement,
  markChartEditable,
  getChartElementData,
  materializeSlide,
  listMasterParts,
  parseMasterPart,
  patchSlideXml,
  TABLE_STYLE_PRESETS,
  setTableColWidth,
  type TableStructureOp,
  type TableStyleEdit,
  EMU_PER_PT,
  getSlideComments,
  getSlideNotes,
  getSlideTransition,
  elementSpid,
  getSlideAnimations,
  setSlideAnimations,
  type SlideAnimation,
  openPptx,
  mergeSlideFromPptx,
  parseTheme,
  pasteElements,
  reorderElement,
  savePptx,
  commitSaved,
  setElementFont,
  replaceAllInDeck,
  mergeTableCells,
  setSlideLayout,
  resetSlideLayout,
  setSlideSize,
  setPictureOpacity,
  setElementConnection,
  updateConnectorsForMoved,
  setElementImageFill,
  setElementTextAnchor,
  setTableRowHeight,
  resizeTable,
  setTableCellAnchor,
  setElementParagraphFormat,
  setGroupChildParagraphFormat,
  setSlideBackground,
  setSlideAdvanceTime,
  setSlideHidden,
  setSlideNotes,
  setSlideTransition,
  getSections,
  setSections,
  addSection,
  renameSection,
  removeSection,
  moveSection,
  moveSlide,
  type SectionInfo,
  type ElementClipboardItem,
  type GroupElement,
  type OpenedPptx,
  type Paragraph,
  type Slide,
  type TableElement,
  type TextElement,
} from '@genoffice/pptx-engine'
import { buildRenderSlide, EMU_PER_PX_96, type RenderSlide } from '@genoffice/pptx-render'
import { refineComplexWidths, shapedMetricsReady } from './shaped-metrics'
import { ensureSystemFontsReady } from './fonts'
import { applyEditParagraphs, collectParagraphFormatPatches, levelsChanged } from './edit-text'
import { cfbKind, isCfbHeader } from './cfb-sniff'
import { unplayableAudioCodec } from './mp4-audio-sniff'
import { tiffToPng } from './tiff-decode'
import { tm } from './i18n-main'
import { isTauri, platform } from '../../../bridge/platform'
import { sha256Hex } from '../../../bridge/node-shims/crypto'
import {
  beginHistoryBatch,
  buildAllRenderSlides,
  carryHistoryForReplacement,
  endHistoryBatch,
  getFontMetrics,
  makeMediaResolver,
  pushHistory,
  rebuildSlide,
  rebuildSlideWithReparse,
  registerAiSnapshot,
  restoreAiSnapshot,
  restoreSnapshot,
  settleStaleHistoryBatch,
  takeSnapshot,
  type Session,
} from './session-state'
import type {
  AddChartOp,
  AddCommentOp,
  AddElementOp,
  AddImageBytesOp,
  AddInkOp,
  AddMediaBytesOp,
  AddBlankSlideOp,
  AddSlideOp,
  PasteSlideOp,
  RepasteSlideOp,
  AddSlideWithLayoutOp,
  AddSmartArtOp,
  AddTableOp,
  ApplyThemeOp,
  HeaderFooterOp,
  SetLinkOp,
  CopyElementsOp,
  DeleteCommentOp,
  DeleteElementOp,
  EditBackgroundOp,
  EditFillOp,
  EditStrokeOp,
  FlipElementOp,
  EditPictureSrcRectOp,
  GroupElementsOp,
  UngroupElementOp,
  BatchEditTransformOp,
  EditTextOp,
  EditTransformOp,
  EditConnectorEndpointsOp,
  SetElementFontOp,
  SetElementParagraphFormatOp,
  FindReplaceOp,
  TableMergeIpcOp,
  SetSlideLayoutOp,
  SetSlideSizeOp,
  MasterEditTextOp,
  MasterEditTransformOp,
  MasterEditFillOp,
  MasterEditStrokeOp,
  MasterDeleteElementOp,
  MasterEnterResult,
  PrintSlidesOp,
  EditPictureOpacityOp,
  ExportImagesOp,
  ExportImagesResult,
  ExportPdfOp,
  ExportPdfResult,
  OpenResult,
  PasteElementsOp,
  DuplicateElementsOp,
  EditTableCellOp,
  EditTableStyleOp,
  EditChartOp,
  SetTableColWidthOp,
  SetTableRowHeightOp,
  SetTableCellAnchorOp,
  TableStructureIpcOp,
  ReorderElementOp,
  SetAdvanceTimesOp,
  SetAnimationsOp,
  SetNotesOp,
  SetSlideHiddenOp,
  SetTransitionOp,
  AddSectionOp,
  RenameSectionOp,
  RemoveSectionOp,
  MoveSectionOp,
  MoveSlideOp,
  AnimationItem,
  GetLayoutsResult,
  LinkTargetOp,
  ShapeKey,
  SlideComment,
  TransitionKind,
} from '../shared/ipc'

// ── byte helpers (no Buffer in a webview) ──────────────────────────────

/** bytes → base64, chunked so spread args don't overflow the stack on large inputs */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

// ── webview replacements for Electron dialogs ──────────────────────────

/** File-open picker: <input type=file>; cancel resolves null like the native dialog's canceled. */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.oncancel = () => resolve(null)
    input.click()
  })
}

/**
 * Pick a file and land its bytes in the byte-store under the file name, so the
 * upstream path-based logic (rejectLegacyPpt/openAndBuild) can re-read them.
 */
async function pickFileBytes(accept: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  const file = await pickFile(accept)
  if (!file) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  await platform.writeFile(file.name, bytes)
  return { name: file.name, bytes }
}

/** Trigger a browser download for bytes (a[download]); like the docs port's saveDocxAs. */
function triggerDownload(fileName: string, bytes: Uint8Array, mime: string): void {
  const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

// ── Module-level host state (upstream kept these process-wide) ─────────

/** One slide, copied from any deck open in this process, waiting to be pasted into another. */
let slideClipboard: { bundle: SlideBundle; png?: string } | null = null

/** The immediately preceding slide paste, so the paste-options floater can redo it with another mode. */
// Port: upstream keyed this per webContents; one editor per webview → a single record
let lastSlidePaste: { afterIndex: number; undoLen: number } | null = null

// ── In-app element clipboard (pasteCount drives cascading offset) ──
// Port: single instance (upstream had one per webContents)
let elementClipboard: { items: ElementClipboardItem[]; pasteCount: number } | null = null

/**
 * Which in-app copy happened last. Upstream ranked internal vs external copies via
 * custom-format OS clipboard markers (io.genoffice.slides.*) — a webview has no
 * custom-format OS clipboard, so the in-app clipboard is authoritative (TODO M4).
 */
let lastCopyKind: 'slide' | 'elements' | null = null

// Cloud-generated single-page pptx: marker strings travel in pagesHtml slots; only paths issued
// by the cloud generator are readable (the renderer can't point the reader at arbitrary files)
const CLOUD_PAGE_PREFIX = 'cloudpptx:'
const issuedCloudPages = new Set<string>()

// ── Recents (localStorage stands in for userData/slides-recent.json) ───
const RECENT_KEY = 'panoffice.slides.recent'
const RECENT_LIMIT = 10

function readRecent(): string[] {
  // TODO(M4): upstream filtered recents by file existence; the byte-store only sees overlay writes
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

function pushRecent(path: string): void {
  const cur = readRecent()
  const next = [path, ...cur.filter((p) => p !== path)].slice(0, RECENT_LIMIT)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* best-effort */
  }
}

/** Comment author name. TODO(M4): upstream read the OS username (node:os userInfo); the webview has no account concept yet. */
function commentAuthorName(): string {
  return 'User'
}

// ── Autosave (crash recovery): a dirty session writes a recovery copy every 30s; a normal save cleans it up ──
// Port: app.getPath('userData') → the 'userData' overlay namespace prefix
const autosaveDir = () => 'userData/slides-autosave'
// Port: sha1 → sha256 for the key hash; keys are opaque, the change is harmless
const autosavePathFor = (filePath: string) =>
  `${autosaveDir()}/${sha256Hex(filePath).slice(0, 16)}.pptx`

function sessionDirty(session: Session): boolean {
  return (
    !!session.metaDirty ||
    session.opened.deck.slides.some(
      (s) => s.structureDirty || s.elements.some((el) => el.dirty || el.dirtyTransform),
    )
  )
}

/**
 * Ticks to skip after a failed recovery copy, per deck. Retrying every 30s just
 * repeats an expensive failure, but disabling the safety net for the rest of the
 * session was worse: on a heavy deck one slow serialization used to remove crash
 * recovery permanently and silently. Back off instead, and keep the
 * skip count so a deck that always fails only pays for it every ~5 minutes.
 */
const autosaveBackoff = new Map<string, number>()
const AUTOSAVE_BACKOFF_TICKS = 10
let autosaveRunning = false

/**
 * Recovery drafts for never-saved decks (visible path in <Documents>/PanOffice):
 * the sha256-keyed recovery copy needs session.path, so before the first save a freeze or
 * crash used to lose everything. Removed on save or explicit discard.
 */
// Port: upstream keyed this map by webContents id; the single-session host keys by a constant string
const untitledRecovery = new Map<string, string>()
const UNTITLED_KEY = 'untitled'

function dropUntitledRecovery(): void {
  const draft = untitledRecovery.get(UNTITLED_KEY)
  if (draft) void platform.deleteFile(draft).catch(() => {})
  untitledRecovery.delete(UNTITLED_KEY)
}

// ── Close guard ──
// Port: upstream's close guard (slides:close-save-result waiters, requestRendererSave,
// requestSlidesClose with its Save/Don't Save/Cancel dialog) cannot live inside the webview —
// the host has no way to block a tab close from here. TODO(M4): bridge-level close guard,
// driven by isDirty()/setAutoSavePref below.

/** Directory where AI-generated drafts are saved: <Documents>/PanOffice/ */
function getDraftsDir(): string {
  return 'Documents/PanOffice'
}

/** Fallback draft filename: <untitled label>-YYYYMMDD-HHmmss.pptx */
function newDraftFilename(): string {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${tm('untitledDraft')}-${date}-${time}.pptx`
}

/** Sanitize an AI-provided topic/title into a safe filename base: strip illegal path chars, collapse whitespace, cap length; null if invalid. */
function sanitizeDraftBaseName(raw: string | undefined): string | null {
  if (!raw) return null
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point here
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Strip leading/trailing dots (Windows disallows a trailing dot; a hidden-file prefix is meaningless here)
    .replace(/^\.+|\.+$/g, '')
    .trim()
  if (!cleaned) return null
  return cleaned.length > 40 ? cleaned.slice(0, 40).trim() : cleaned
}

/** Pick a draft path from deckName: append -2/-3… if a same-named file exists; fall back to timestamp naming without a valid deckName. */
// Port: async because platform.exists is a round-trip, and it only sees overlay writes — on
// Tauri real-disk collisions aren't detected, so the -2/-3 walk never triggers there (TODO M3: stat)
async function pickDraftPath(draftsDir: string, deckName?: string): Promise<string> {
  const base = sanitizeDraftBaseName(deckName)
  if (base) {
    let candidate = `${draftsDir}/${base}.pptx`
    for (let i = 2; (await platform.exists(candidate)) && i < 100; i++) {
      candidate = `${draftsDir}/${base}-${i}.pptx`
    }
    if (!(await platform.exists(candidate))) return candidate
  }
  return `${draftsDir}/${newDraftFilename()}`
}

/** Theme body (minor) Latin font: fallback shown in the ribbon font box when the selection has no text element. */
function deckDefaultFont(opened: OpenedPptx): string | undefined {
  try {
    const slidePath = opened.archive.readPresentation().slidePaths[0]
    if (!slidePath) return undefined
    const themePath = opened.archive.resolveSlideChain(slidePath).themePath
    const xml = themePath ? opened.archive.readText(themePath) : undefined
    return xml ? parseTheme(xml).minorFont : undefined
  } catch {
    return undefined
  }
}

/**
 * Unique fontFamily values across all runs of the deck (text elements, table cells, group
 * children), capped at 50 — warmup input for the system-font index before the first layout.
 */
function deckFontFamilies(opened: OpenedPptx): string[] {
  const FAMILY_CAP = 50
  const families = new Set<string>()
  const collectText = (text: TextElement['text'] | undefined) => {
    for (const p of text?.paragraphs ?? []) {
      for (const r of p.runs ?? []) {
        if (r.fontFamily) families.add(r.fontFamily)
        if (families.size >= FAMILY_CAP) return
      }
    }
  }
  const collectEl = (el: Slide['elements'][number]): void => {
    if (families.size >= FAMILY_CAP) return
    if (el.type === 'text' || el.type === 'shape') {
      collectText((el as TextElement).text)
    } else if (el.type === 'table') {
      for (const row of (el as TableElement).rows ?? []) {
        for (const cell of row ?? []) collectText(cell?.text)
      }
    } else if (el.type === 'group') {
      for (const child of (el as GroupElement).children ?? []) collectEl(child)
    }
  }
  for (const slide of opened.deck.slides) {
    for (const el of slide.elements) collectEl(el)
    if (families.size >= FAMILY_CAP) break
  }
  return [...families]
}

function findEl(slide: Slide, sourceId: string): TextElement | undefined {
  const el = slide.elements.find((e) => e.id === sourceId)
  if (el && (el.type === 'text' || el.type === 'shape')) return el as TextElement
  return undefined
}

/**
 * .ppt (97-2003 binary compound document) and encrypted OOXML are unsupported: warn instead of a parse error.
 * Detection uses the magic number rather than the extension -- a binary ppt with a renamed suffix is caught too. A CFB containing an
 * EncryptedPackage stream is a password-protected pptx and gets dedicated copy (instead of being mislabeled as the legacy format).
 */
async function rejectLegacyPpt(path: string): Promise<boolean> {
  // Port: upstream read 8 bytes via fs.open; the byte-store reads whole files (they are small here)
  let bytes: Uint8Array
  try {
    bytes = await platform.readFile(path)
  } catch {
    return false
  }
  if (!isCfbHeader(bytes.slice(0, 8))) return false
  const kind = cfbKind(bytes) ?? 'legacy'
  // TODO(M4): real modal dialog
  console.warn(
    '[slides]',
    `${tm(kind === 'encrypted' ? 'encryptedPptxTitle' : 'legacyPptTitle')}\n${tm(
      kind === 'encrypted' ? 'encryptedPptxBody' : 'legacyPptBody',
    )}`,
  )
  return true
}

/** On open, if a recovery copy exists, keep it and open the ORIGINAL bytes. */
async function maybeRecoverBytes(
  path: string,
  original: Uint8Array,
): Promise<{ bytes: Uint8Array; recovered: boolean }> {
  // TODO(M4): recovery restore prompt needs mtime — the byte-store tracks none
  // (upstream compared the recovery copy's mtime against the original and asked Restore/Discard)
  if (await platform.exists(autosavePathFor(path))) {
    console.warn('[slides]', `${tm('autosaveFoundTitle')}\n${tm('autosaveFoundBody')}`)
  }
  return { bytes: original, recovered: false }
}

/** Legacy fixed color schemes (AI tools/old files still pass these keys; kept as fallback). */
const CHART_COLOR_SCHEMES: Record<string, string[]> = {
  default: [],
  blue: ['#2E75B6', '#4472C4', '#5B9BD5', '#70AD47', '#ED7D31'],
  warm: ['#ED7D31', '#FFC000', '#FF0000', '#C55A11', '#833C00'],
  cool: ['#0070C0', '#00B0F0', '#00B0A0', '#7030A0', '#2E75B6'],
  mono: ['#404040', '#666666', '#888888', '#AAAAAA', '#CCCCCC'],
}

/** PowerPoint default theme accent sequence (fallback when the deck has no theme colors). */
const FALLBACK_ACCENTS = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47']

/** Mix a hex color with black/white by ratio (for mono-gradient steps). */
function mixHex(hex: string, target: number, ratio: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return hex
  const v = parseInt(m[1]!, 16)
  const ch = (x: number) => Math.round(x + (target - x) * ratio)
  const r = ch((v >> 16) & 255)
  const g = ch((v >> 8) & 255)
  const b = ch(v & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase()}`
}

/** Current deck's theme accent1..6 (read from the theme part of the first slide's inheritance chain). */
function deckAccents(opened: OpenedPptx): string[] {
  const slide = opened.deck.slides[0]
  if (!slide) return FALLBACK_ACCENTS
  try {
    const chain = opened.archive.resolveSlideChain(slide.path)
    const xml = chain.themePath ? opened.archive.readText(chain.themePath) : null
    const colors = xml ? parseTheme(xml).colors : undefined
    const acc = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
      .map((k) => colors?.[k])
      .filter((c): c is string => !!c)
    return acc.length >= 3 ? acc : FALLBACK_ACCENTS
  } catch {
    return FALLBACK_ACCENTS
  }
}

/** Theme-derived color schemes for the chart "Change Colors" gallery: two colorful sets + one mono gradient per accent. */
function chartColorSchemes(
  opened: OpenedPptx,
): Array<{ key: string; label: string; colors: string[] }> {
  const acc = deckAccents(opened)
  const rot = [...acc.slice(3), ...acc.slice(0, 3)]
  const mono = (c: string) => [
    mixHex(c, 0, 0.25),
    c,
    mixHex(c, 255, 0.25),
    mixHex(c, 255, 0.45),
    mixHex(c, 255, 0.65),
  ]
  return [
    { key: 'default', label: tm('schemeThemeDefault'), colors: [] },
    { key: 'colorful', label: tm('schemeColorful'), colors: acc },
    { key: 'colorful2', label: tm('schemeColorful2'), colors: rot },
    ...acc.map((c, i) => ({
      key: `mono-accent${i + 1}`,
      label: tm('schemeMono', { n: i + 1 }),
      colors: mono(c),
    })),
  ]
}

/** Full-page "backdrop" rectangles: design templates often use a text-free solid rectangle
 * covering the whole page as background; changing only the page background would be hidden
 * behind them — so recolor such rectangles along with the background. */
function recolorFullBleedBackdrops(
  slide: Slide,
  size: { cx: number; cy: number },
  color: string,
): void {
  for (const el of slide.elements) {
    if (el.type !== 'shape' && el.type !== 'text') continue
    const shaped = el as TextElement
    const fillType = shaped.fill?.type
    if (fillType !== 'solid' && fillType !== 'gradient') continue
    if (shaped.text?.paragraphs.some((p) => p.runs.some((r) => r.text.trim()))) continue
    const { x, y, cx, cy } = el.transform.offset
    const coversX = x <= size.cx * 0.05 && x + cx >= size.cx * 0.95
    const coversY = y <= size.cy * 0.05 && y + cy >= size.cy * 0.95
    if (!coversX || !coversY) continue
    shaped.fill = { type: 'solid', color }
    shaped.dirtyFill = true
  }
}

function performSlidePaste(
  session: Session,
  op: PasteSlideOp,
): { slides: RenderSlide[]; index: number; sourceId?: string } | null {
  if (!slideClipboard) return null
  if (op.mode === 'picture') {
    const { deck } = session.opened
    const anchorIndex = Math.min(Math.max(op.afterIndex, 0), deck.slides.length - 1)
    const slide = deck.slides[anchorIndex]
    if (!slide || !slideClipboard.png) return null
    const el = addPicture(session.opened, slide, {
      bytes: base64ToBytes(slideClipboard.png),
      ext: 'png',
      offset: { x: 0, y: 0, cx: deck.size.cx, cy: deck.size.cy },
    })
    if (!el) return null
    session.fitWidthPx = op.fitWidthPx
    return {
      slides: buildAllRenderSlides(session.opened, op.fitWidthPx),
      index: anchorIndex,
      sourceId: el.id,
    }
  }
  const slide = pasteSlide(session.opened, op.afterIndex, slideClipboard.bundle, {
    keepSourceFormatting: op.mode === 'source',
  })
  if (!slide) return null
  session.fitWidthPx = op.fitWidthPx
  return {
    slides: buildAllRenderSlides(session.opened, op.fitWidthPx),
    index: session.opened.deck.slides.indexOf(slide),
  }
}

export class SlidesHost {
  /** Single session (upstream keyed sessions by webContents id; one slides editor per webview). */
  private session: Session | null = null

  /** Autosave toggle mirrored from the renderer: files with it on save silently on close and proceed, no dialog */
  private autoSavePref = false

  /** The autosave loop starts lazily on first session creation (not at module import) */
  private autosaveStarted = false

  /**
   * Optional events the bridge can subscribe to (the host never pushes renderer events itself):
   * fired after a successful open (upstream: slidesOpenedHook), and on an external rename
   * (upstream: wc.send('slides:renamed')).
   */
  onOpened?: (result: OpenResult) => void
  onRenamed?: (newPath: string) => void

  /** Upstream bailed out of each handler (usually with null) when the sender had no session. */
  private requireSession(): Session | null {
    return this.session
  }

  // ── Open ─────────────────────────────────────────────────────────────

  /** slides:open — pick a .pptx/.ppt file and open it (cancel → null). */
  async openPptx(fitWidthPx: number): Promise<OpenResult | null> {
    const picked = await pickFileBytes('.pptx,.ppt')
    if (!picked) return null
    if (await rejectLegacyPpt(picked.name)) return null
    return this.openAndBuild(picked.name, fitWidthPx)
  }

  /** slides:open-path */
  async openPptxPath(path: string, fitWidthPx: number): Promise<OpenResult | null> {
    if (!path) return null
    // Port: platform.exists only sees overlay writes (not real disk / fetchable URLs), so
    // existence is probed by reading — open failures land here as null like upstream's existsSync gate
    try {
      if (await rejectLegacyPpt(path)) return null
      return await this.openAndBuild(path, fitWidthPx)
    } catch {
      return null
    }
  }

  /**
   * slides:consume-pending-open — the bridge extracts `path` from the URL hash.
   * A live session wins (remount after an HMR full reload/crash recovery: restore from the
   * host-side session; reopening from disk would lose unsaved edits).
   */
  async consumePendingOpen(path: string | null, fitWidthPx: number): Promise<OpenResult | null> {
    const session = this.session
    if (session) {
      session.fitWidthPx = fitWidthPx
      return {
        path: session.path,
        slides: buildAllRenderSlides(session.opened, fitWidthPx),
        size: { cx: session.opened.deck.size.cx, cy: session.opened.deck.size.cy },
        defaultFont: deckDefaultFont(session.opened),
      }
    }
    if (path) {
      try {
        return await this.openAndBuild(path, fitWidthPx)
      } catch {
        // Parse/read failure on mount: fall back to the start screen rather than an unhandled rejection
        return null
      }
    }
    return null
  }

  private async openAndBuild(path: string, fitWidthPx: number): Promise<OpenResult> {
    const raw = await platform.readFile(path)
    const { bytes, recovered } = await maybeRecoverBytes(path, raw)
    const opened = await openPptx(bytes)
    this.session = {
      path,
      opened,
      fitWidthPx,
      undoStack: [],
      redoStack: [],
      ...(recovered ? { metaDirty: true } : {}),
    }
    this.ensureAutosaveLoop()
    pushRecent(path)
    // Font warmup before the first layout: complex-script shaped metrics + the system-font
    // index for the deck's families, so no layout pass falls back to estimation
    await shapedMetricsReady()
    await ensureSystemFontsReady(deckFontFamilies(opened))
    let slides = buildAllRenderSlides(opened, fitWidthPx)
    // If the first layout pass had complex-script misses (Arabic/Thai etc.), re-lay out once with renderer-measured widths
    if (await refineComplexWidths()) slides = buildAllRenderSlides(opened, fitWidthPx)
    const result: OpenResult = {
      path,
      slides,
      size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
      defaultFont: deckDefaultFont(opened),
    }
    // Port: upstream notified the shell via slidesOpenedHook; the bridge decides whether to emit
    this.onOpened?.(result)
    return result
  }

  /** slides:new-blank — new blank presentation (single blank 16:9 page, untitled) */
  async newBlank(fitWidthPx: number): Promise<OpenResult> {
    const opened = await openPptx(await createBlankPptx())
    this.session = { path: '', opened, fitWidthPx, undoStack: [], redoStack: [] }
    this.ensureAutosaveLoop()
    return {
      path: '',
      slides: buildAllRenderSlides(opened, fitWidthPx),
      size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
      defaultFont: deckDefaultFont(opened),
    }
  }

  // ── Autosave loop (started lazily on first session creation) ─────────

  private ensureAutosaveLoop(): void {
    if (this.autosaveStarted) return
    this.autosaveStarted = true
    setInterval(() => {
      if (autosaveRunning) return
      autosaveRunning = true
      void (async () => {
        const session = this.session
        if (session && !session.masterEdit && sessionDirty(session)) {
          let target: string
          if (session.path) {
            target = autosavePathFor(session.path)
          } else {
            let draft = untitledRecovery.get(UNTITLED_KEY)
            if (!draft) {
              draft = `${getDraftsDir()}/${newDraftFilename()}`
              untitledRecovery.set(UNTITLED_KEY, draft)
            }
            target = draft
          }
          const backoffKey = session.path ?? target
          const skip = autosaveBackoff.get(backoffKey) ?? 0
          if (skip > 0) {
            autosaveBackoff.set(backoffKey, skip - 1)
          } else {
            try {
              // Port: savePptxToFile needs node:fs — serialize in-memory and write through the
              // byte-store (the overlay is flat; no mkdir)
              const bytes = await savePptx(session.opened)
              await platform.writeFile(target, bytes)
              autosaveBackoff.delete(backoffKey)
            } catch (error) {
              autosaveBackoff.set(backoffKey, AUTOSAVE_BACKOFF_TICKS)
              console.warn('[slides] autosave failed, retrying in ~5 min:', error)
            }
          }
        }
      })().finally(() => {
        autosaveRunning = false
      })
    }, 30_000)
  }

  // ── Text / font / paragraph ──────────────────────────────────────────

  /** slides:edit-text */
  async editText(op: EditTextOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    // In-group editing: after updating a child's paragraphs, patch the text of the child slice inside the group's originalXml
    if (op.groupId) {
      const found = findGroupChild(slide, op.groupId, op.sourceId)
      const child = found?.child
      if (!child || (child.type !== 'text' && child.type !== 'shape')) return null
      const textChild = child as TextElement
      if (!textChild.text) return null
      pushHistory(session)
      textChild.text.paragraphs = applyEditParagraphs(textChild.text.paragraphs, op.paragraphs)
      ensureRunLinkRels(session.opened, op.slideIndex, textChild.text.paragraphs)
      if (!patchGroupChildText(slide, op.groupId, textChild)) {
        restoreSnapshot(session, session.undoStack.pop()!) // Slice not located: roll back the already-modified model
        return null
      }
      for (const { index, patch } of collectParagraphFormatPatches(op.paragraphs)) {
        setGroupChildParagraphFormat(slide, op.groupId, op.sourceId, patch, [index])
      }
      return rebuildSlide(session, op.slideIndex)
    }
    const el = findEl(slide, op.sourceId)
    if (!el || !el.text) return null
    pushHistory(session)
    // Run-level rich-text rebuild: srcPara/srcRun back-tracing + preserving unedited fields, see applyEditParagraphs
    const levelDirty = levelsChanged(el.text.paragraphs, op.paragraphs)
    el.text.paragraphs = applyEditParagraphs(el.text.paragraphs, op.paragraphs)
    ensureRunLinkRels(session.opened, op.slideIndex, el.text.paragraphs)
    el.dirty = true
    // Per-paragraph bullets/spacing marked on the editor selection
    for (const { index, patch } of collectParagraphFormatPatches(op.paragraphs)) {
      setElementParagraphFormat(slide, op.sourceId, patch, [index])
    }
    if (levelDirty) {
      // Level changes affect inheritance (font size/bullet/indent take master defaults by lvl); bake into bytes then reparse
      el.dirtyPPr = { ...el.dirtyPPr, level: true, indents: true }
      materializeSlide(session.opened, op.slideIndex)
      return rebuildSlide(session, op.slideIndex)
    }
    const rendered = this.applyAutofitResize(
      op.slideIndex,
      op.sourceId,
      rebuildSlide(session, op.slideIndex),
    )
    return this.syncAutofitScale(op.slideIndex, op.sourceId, rendered)
  }

  /** slides:set-element-font */
  async setElementFont(op: SetElementFontOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    let changed = false
    for (const id of op.sourceIds) {
      const ok = op.groupId
        ? setGroupChildFont(slide, op.groupId, id, {
            fontFamily: op.fontFamily,
            fontSizePt: op.fontSizePt,
            strike: op.strike,
            bold: op.bold,
            italic: op.italic,
            underline: op.underline,
            color: op.color,
          })
        : setElementFont(slide, id, {
            fontFamily: op.fontFamily,
            fontSizePt: op.fontSizePt,
            strike: op.strike,
            bold: op.bold,
            italic: op.italic,
            underline: op.underline,
            color: op.color,
          })
      if (ok) changed = true
    }
    if (!changed) {
      session.undoStack.pop() // All non-text elements (images etc.): nothing happened, pop the just-pushed history
      return null
    }
    let rendered = rebuildSlide(session, op.slideIndex)
    for (const id of op.sourceIds) {
      rendered = this.applyAutofitResize(op.slideIndex, id, rendered)
      rendered = this.syncAutofitScale(op.slideIndex, id, rendered)
    }
    return rendered
  }

  /** slides:set-element-paragraph-format */
  async setElementParagraphFormat(op: SetElementParagraphFormatOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    const patch = {
      bullet: op.bullet,
      bulletChar: op.bulletChar,
      bulletHangEmu: op.bulletHangEmu,
      bulletSizePct: op.bulletSizePct,
      bulletColor: op.bulletColor,
      lineSpacingPct: op.lineSpacingPct,
      spaceBeforePt: op.spaceBeforePt,
      spaceAfterPt: op.spaceAfterPt,
      align: op.align,
      indentDelta: op.indentDelta,
    }
    let changed = false
    for (const id of op.sourceIds) {
      const ok = op.groupId
        ? setGroupChildParagraphFormat(slide, op.groupId, id, patch)
        : setElementParagraphFormat(slide, id, patch)
      if (ok) changed = true
    }
    if (!changed) {
      session.undoStack.pop()
      return null
    }
    if (op.indentDelta) {
      // Level changes affect inherited defaults; bake into bytes then reparse
      materializeSlide(session.opened, op.slideIndex)
      return rebuildSlide(session, op.slideIndex)
    }
    let rendered = rebuildSlide(session, op.slideIndex)
    for (const id of op.sourceIds) {
      rendered = this.applyAutofitResize(op.slideIndex, id, rendered)
      rendered = this.syncAutofitScale(op.slideIndex, id, rendered)
    }
    return rendered
  }

  /**
   * spAutoFit (autofit='resize', "resize shape to fit text"): after a text change, the box height
   * grows/shrinks with the content and is written back to cy. rendered = the
   * rebuilt result after this change; when the height changed, update the transform and rebuild
   * once more. Top-level elements only (group children use a different coordinate system, skip).
   */
  private applyAutofitResize(
    slideIndex: number,
    sourceId: string,
    rendered: RenderSlide | null,
  ): RenderSlide | null {
    const session = this.session
    if (!session || !rendered) return rendered
    const slide = session.opened.deck.slides[slideIndex]
    const el = slide ? findEl(slide, sourceId) : undefined
    if (!el?.text || el.text.autofit !== 'resize') return rendered
    const node = rendered.nodes.find((n) => n.sourceId === sourceId)
    if (!node || (node.type !== 'shape' && node.type !== 'text') || !node.text) return rendered
    const needH = node.text.contentHeight + node.text.insets.t + node.text.insets.b
    if (Math.abs(needH - node.box.h) < 1) return rendered
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = session.fitWidthPx / baseWidthPx
    el.transform = {
      ...el.transform,
      offset: {
        ...el.transform.offset,
        cy: Math.max(Math.round((needH / scale) * EMU_PER_PX_96), 1),
      },
    }
    el.dirtyTransform = true
    return rebuildSlide(session, slideIndex)
  }

  /**
   * normAutofit fontScale write-back: when the shrink ratio the layout actually used after a text
   * edit (≤ the stored cap, shrink-only) differs from the stored model value, sync the model and
   * patch the bodyPr attribute — only then does PowerPoint show the same size on open.
   * Triggered only by text edits (resize gestures do not write: the layout cap locks the stored
   * value, and writing back during a gesture would ratchet one way); top-level elements only.
   */
  private syncAutofitScale(
    slideIndex: number,
    sourceId: string,
    rendered: RenderSlide | null,
  ): RenderSlide | null {
    const session = this.session
    if (!session || !rendered) return rendered
    const slide = session.opened.deck.slides[slideIndex]
    const el = slide ? findEl(slide, sourceId) : undefined
    if (!el?.text || el.text.autofit !== 'shrink') return rendered
    const node = rendered.nodes.find((n) => n.sourceId === sourceId)
    if (!node || (node.type !== 'shape' && node.type !== 'text') || !node.text) return rendered
    const effective = node.text.fontScale
    const effectiveRed = node.text.lnSpcReduction ?? 0
    if (
      Math.abs(effective - (el.text.fontScale ?? 1)) < 0.005 &&
      Math.abs(effectiveRed - (el.text.lnSpcReduction ?? 0)) < 0.005
    )
      return rendered
    el.text.fontScale = effective
    if (effectiveRed) el.text.lnSpcReduction = effectiveRed
    else delete el.text.lnSpcReduction
    el.anchor.originalXml = patchBodyPrAutofit(el.anchor.originalXml, effective, effectiveRed)
    slide!.structureDirty = true
    return rendered // The layout already rendered with the effective value; no rebuild needed
  }

  /** slides:edit-transform */
  async editTransform(op: EditTransformOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const el = op.groupId ? null : slide.elements.find((x) => x.id === op.sourceId)
    const grpChild = op.groupId ? findGroupChild(slide, op.groupId, op.sourceId) : null
    if (!el && !grpChild) return null
    // Undo semantics for preview gestures: one whole drag = one undo step.
    // The first preview pushes a pre-gesture snapshot; later previews and the final commit do not.
    if (op.preview) {
      if (!session.transformPreview) {
        pushHistory(session)
        session.transformPreview = true
      }
    } else if (session.transformPreview) {
      session.transformPreview = false
    } else {
      pushHistory(session)
    }
    // px -> EMU (inverting the viewport scale)
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    // In-group editing: the pixel box is in group-local coords (with ext/chExt scaling baked in); divide out the group scale first, then convert back to the child EMU coordinate system
    if (grpChild) {
      const ch = grpChild.grp.childOffset
      const chX = ch?.x ?? grpChild.grp.transform.offset.x
      const chY = ch?.y ?? grpChild.grp.transform.offset.y
      const gExt = grpChild.grp.transform.offset
      const gsx = ch?.cx ? gExt.cx / ch.cx : 1
      const gsy = ch?.cy ? gExt.cy / ch.cy : 1
      const ok = editGroupChildTransform(
        slide,
        op.groupId!,
        op.sourceId,
        {
          x: toEmu(op.xPx / gsx) + chX,
          y: toEmu(op.yPx / gsy) + chY,
          cx: toEmu(op.wPx / gsx),
          cy: toEmu(op.hPx / gsy),
        },
        op.rotationDeg,
      )
      if (!ok) {
        session.undoStack.pop() // Slice not located: model untouched, pop the just-pushed history
        return null
      }
      return rebuildSlide(session, op.slideIndex)
    }
    // Tables: redistribute gridCol widths / tr heights so the file matches the
    // frame instead of keeping the old grid under a new a:ext
    const isTable = el!.type === 'table'
    if (isTable) resizeTable(slide, op.sourceId, toEmu(op.wPx), toEmu(op.hPx))
    el!.transform = {
      ...el!.transform,
      offset: {
        x: toEmu(op.xPx),
        y: toEmu(op.yPx),
        // resizeTable synced cx/cy to the redistributed sums
        cx: isTable ? el!.transform.offset.cx : toEmu(op.wPx),
        cy: isTable ? el!.transform.offset.cy : toEmu(op.hPx),
      },
      rot: Math.round(op.rotationDeg * 60000),
    }
    el!.dirtyTransform = true
    updateConnectorsForMoved(slide, [op.sourceId])
    return rebuildSlide(session, op.slideIndex)
  }

  // Connector endpoint drag: box+flip re-derived from the two endpoints;
  // attach/detach writes a:stCxn/a:endCxn so the connector follows later shape moves
  /** slides:edit-connector-endpoints */
  async editConnectorEndpoints(op: EditConnectorEndpointsOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const el = slide.elements.find((x) => x.id === op.sourceId)
    if (!el) return null
    pushHistory(session)
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const p1 = { x: toEmu(op.x1Px), y: toEmu(op.y1Px) }
    const p2 = { x: toEmu(op.x2Px), y: toEmu(op.y2Px) }
    el.transform = {
      ...el.transform,
      offset: {
        x: Math.min(p1.x, p2.x),
        y: Math.min(p1.y, p2.y),
        cx: Math.abs(p2.x - p1.x),
        cy: Math.abs(p2.y - p1.y),
      },
      rot: 0,
      flipH: p1.x > p2.x,
      flipV: p1.y > p2.y,
    }
    el.dirtyTransform = true
    const toRef = (
      v: { targetId: string; idx: number } | null | undefined,
    ): { id: number; idx: number } | null | undefined => {
      if (v === undefined) return undefined
      if (v === null) return null
      const target = slide.elements.find((x) => x.id === v.targetId)
      const spid = target ? elementSpid(target) : null
      return spid != null ? { id: spid, idx: v.idx } : null
    }
    setElementConnection(slide, op.sourceId, { start: toRef(op.start), end: toRef(op.end) })
    return rebuildSlide(session, op.slideIndex)
  }

  // Read-only: RenderSlide for every page of the current session (E2E driver/debug use, no state change)
  /** slides:get-render-slides */
  async getRenderSlides(): Promise<RenderSlide[] | null> {
    const session = this.requireSession()
    if (!session) return null
    // Indices come from the deck itself, so rebuildSlide cannot miss here (upstream typed the
    // IPC boundary loosely; SlidesApi declares RenderSlide[])
    return session.opened.deck.slides.map((_, i) => rebuildSlide(session, i)!)
  }

  /** slides:batch-edit-transform */
  async batchEditTransform(op: BatchEditTransformOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    // Validate: every element must exist
    const pairs: Array<{ el: (typeof slide.elements)[0]; item: BatchEditTransformOp['items'][0] }> =
      []
    for (const item of op.items) {
      const el = slide.elements.find((x) => x.id === item.sourceId)
      if (!el) return null
      pairs.push({ el, item })
    }
    pushHistory(session)
    for (const { el, item } of pairs) {
      el.transform = {
        ...el.transform,
        offset: {
          x: toEmu(item.xPx),
          y: toEmu(item.yPx),
          cx: toEmu(item.wPx),
          cy: toEmu(item.hPx),
        },
        rot: Math.round(item.rotationDeg * 60000),
      }
      el.dirtyTransform = true
    }
    updateConnectorsForMoved(
      slide,
      op.items.map((i) => i.sourceId),
    )
    return rebuildSlide(session, op.slideIndex)
  }

  // ── Cloud single-page generation ──
  // Port: gsk slide_generate runs in the Electron main process with node fetch; the webview
  // cannot reach it (and @genoffice/ai-search is excluded), so generation is always off here.
  // The cloudpptx:<path> marker READ path in htmlToPptx is kept verbatim.

  /** slides:cloud-gen-status */
  async cloudGenStatus(): Promise<{ enabled: boolean }> {
    // TODO(M4): host-side network proxy for cloud generation
    return { enabled: false }
  }

  /** slides:cloud-page-generate */
  cloudGeneratePage(_op: {
    brief: string
    title?: string
    styleSkill?: string
    deckContext?: Record<string, unknown>
    images?: { url: string; caption?: string }[]
    width?: number
    height?: number
  }): Promise<{ ok: boolean; marker?: string; error?: string }> {
    return Promise.resolve({
      ok: false,
      error: 'cloud generation needs a host-side network proxy (TODO M4)',
    })
  }

  /** slides:html-to-pptx */
  async htmlToPptx(
    pagesHtml: string[],
    fitWidthPx: number,
    mode?: 'replace' | 'append' | 'replace_at' | 'insert_at',
    atIndex?: number,
    deckName?: string,
  ): Promise<
    | (OpenResult & {
        appendedFrom?: number
        replacedIndex?: number
        insertedIndex?: number
        fallbackReason?: string
        imageFailures?: { page: number; url: string }[]
      })
    | { error: string }
  > {
    // Every page arrives as a cloud marker (cloudpptx:<path> written by the cloud generator,
    // pointing at a one-slide pptx temp file); this handler only reads and lands the bytes.
    // replace: assemble the whole batch into one multi-page pptx as the new deck base.
    // append: merge the "new pages" one by one into the existing deck via mergeSlideFromPptx
    // (earlier pages are untouched).
    const readCloudPage = async (marker: string): Promise<{ bytes: Uint8Array }> => {
      if (!marker.startsWith(CLOUD_PAGE_PREFIX)) throw new Error('expected a cloud page marker')
      const path = marker.slice(CLOUD_PAGE_PREFIX.length)
      if (!issuedCloudPages.has(path)) throw new Error('unknown cloud page marker')
      return { bytes: await platform.readFile(path) }
    }
    const assembleDeck = async (): Promise<{ bytes: Uint8Array }> => {
      const perPage = await Promise.all(pagesHtml.map(readCloudPage))
      const base = await openPptx(perPage[0]!.bytes)
      for (const one of perPage.slice(1)) await mergeSlideFromPptx(base, one.bytes)
      return { bytes: await savePptx(base) }
    }

    try {
      // Append: convert only the "new pages" and merge them one by one into the existing
      // in-memory deck via mergeSlideFromPptx. Already-landed pages stay untouched
      // (O(N) rather than O(N²)); no dependency on stored PageVisualData.
      if (mode === 'append') {
        const existing = this.session
        if (!existing) {
          return { error: tm('errNoDeckAppend') }
        }
        const opened = existing.opened
        const beforeCount = opened.deck.slides.length
        // Push an undo snapshot: appending is an ordinary edit, ⌘Z should return to the
        // pre-append state (previously the undoStack was simply cleared, making all of the
        // user's prior manual edits non-undoable — inconsistent with replace_at behavior)
        pushHistory(existing)
        let merged = 0
        let lastErr: string | undefined
        for (const html of pagesHtml) {
          try {
            const one = await readCloudPage(html)
            const slide = await mergeSlideFromPptx(opened, one.bytes)
            if (slide) merged += 1
            else lastErr = tm('errMergeFailed')
          } catch (pageErr) {
            lastErr = pageErr instanceof Error ? pageErr.message : String(pageErr)
          }
        }
        if (merged === 0) {
          existing.undoStack.pop() // Nothing happened, pop the just-pushed snapshot
          return { error: tm('errAppendFailed', { reason: lastErr ?? tm('errUnknown') }) }
        }
        existing.fitWidthPx = fitWidthPx
        // Save the draft: persist the current complete deck
        const bytes = await savePptx(opened)
        await this.saveDraftAfterGenerate(existing, bytes, 'append', deckName)
        // Draft now matches memory: reopen from the output bytes to clear dirty (same as
        // slides:save) — otherwise pure AI generation (per-page append merges mark
        // structureDirty) would trigger the close confirmation even without edits
        if (existing.path) {
          existing.opened = await openPptx(bytes)
          existing.metaDirty = false
        }
        return {
          path: existing.path,
          slides: buildAllRenderSlides(existing.opened, fitWidthPx),
          size: { cx: existing.opened.deck.size.cx, cy: existing.opened.deck.size.cy },
          defaultFont: deckDefaultFont(existing.opened),
          appendedFrom: beforeCount,
          ...(lastErr && merged < pagesHtml.length
            ? { fallbackReason: tm('errPartialAppend', { reason: lastErr }) }
            : {}),
        }
      }

      // Redo one page in place: single-page HTML -> single-page pptx -> merge at the end ->
      // moveSlide into position -> delete the old page. Conversion happens first (deck
      // untouched); the mutation phase takes one undo snapshot overall, so ⌘Z rolls back to the
      // old page.
      if (mode === 'replace_at') {
        const existing = this.session
        if (!existing) {
          return { error: tm('errNoDeckReplace') }
        }
        const opened = existing.opened
        const total = opened.deck.slides.length
        if (atIndex == null || !Number.isInteger(atIndex) || atIndex < 0 || atIndex >= total) {
          return { error: tm('errIndexRange', { max: total - 1 }) }
        }
        const html = pagesHtml[0]
        if (!html || pagesHtml.length !== 1) {
          return { error: tm('errReplaceNeedsOne') }
        }
        const one = await readCloudPage(html)
        pushHistory(existing)
        const rollback = () => {
          const snap = existing.undoStack.pop()
          if (snap) restoreSnapshot(existing, snap)
        }
        const merged = await mergeSlideFromPptx(opened, one.bytes)
        if (!merged) {
          rollback()
          return { error: tm('errMergeFailed') }
        }
        // The new page is at the end (index=total); after moving to atIndex the old page gets pushed to atIndex+1, delete it
        if (!moveSlide(opened, total, atIndex) || !deleteSlide(opened, atIndex + 1)) {
          rollback()
          return { error: tm('errReplaceFailed') }
        }
        existing.fitWidthPx = fitWidthPx
        const bytes = await savePptx(opened)
        await this.saveDraftAfterGenerate(existing, bytes, 'append', deckName)
        if (existing.path) {
          existing.opened = await openPptx(bytes)
          existing.metaDirty = false
        }
        return {
          path: existing.path,
          slides: buildAllRenderSlides(existing.opened, fitWidthPx),
          size: { cx: existing.opened.deck.size.cx, cy: existing.opened.deck.size.cy },
          defaultFont: deckDefaultFont(existing.opened),
          replacedIndex: atIndex,
        }
      }

      // Insert one page at atIndex (later pages shift back): used to regenerate a failed middle
      // page from generate_deck and put it back in place. Same mechanism as replace_at (merge at
      // the end -> moveSlide into position) but without deleting an old page.
      if (mode === 'insert_at') {
        const existing = this.session
        if (!existing) {
          return { error: tm('errNoDeckInsert') }
        }
        const opened = existing.opened
        const total = opened.deck.slides.length
        if (atIndex == null || !Number.isInteger(atIndex) || atIndex < 0 || atIndex > total) {
          return { error: tm('errIndexRange', { max: total }) }
        }
        const html = pagesHtml[0]
        if (!html || pagesHtml.length !== 1) {
          return { error: tm('errInsertNeedsOne') }
        }
        const one = await readCloudPage(html)
        pushHistory(existing)
        const rollback = () => {
          const snap = existing.undoStack.pop()
          if (snap) restoreSnapshot(existing, snap)
        }
        const merged = await mergeSlideFromPptx(opened, one.bytes)
        if (!merged) {
          rollback()
          return { error: tm('errMergeFailed') }
        }
        // The new page is at the end (index=total); with atIndex=total it belongs at the end anyway, no move needed
        if (atIndex < total && !moveSlide(opened, total, atIndex)) {
          rollback()
          return { error: tm('errInsertFailed') }
        }
        existing.fitWidthPx = fitWidthPx
        const bytes = await savePptx(opened)
        await this.saveDraftAfterGenerate(existing, bytes, 'append', deckName)
        if (existing.path) {
          existing.opened = await openPptx(bytes)
          existing.metaDirty = false
        }
        return {
          path: existing.path,
          slides: buildAllRenderSlides(existing.opened, fitWidthPx),
          size: { cx: existing.opened.deck.size.cx, cy: existing.opened.deck.size.cy },
          defaultFont: deckDefaultFont(existing.opened),
          insertedIndex: atIndex,
        }
      }

      // replace mode: assemble the whole batch into one multi-page pptx as the new deck base.
      const { bytes } = await assembleDeck()
      const opened = await openPptx(bytes)
      // With per-page conversion + merging, stored PageVisualData is no longer needed; append reads the opened deck directly.
      const replaceSession: Session = {
        path: '',
        opened,
        fitWidthPx,
        undoStack: [],
        redoStack: [],
        htmlPages: null,
      }
      carryHistoryForReplacement(this.session ?? undefined, replaceSession)
      this.session = replaceSession
      this.ensureAutosaveLoop()
      // Save the draft: await completion so the real path is returned; on failure degrade silently (session.path stays '')
      await this.saveDraftAfterGenerate(replaceSession, bytes, 'replace', deckName)
      return {
        path: replaceSession.path,
        slides: buildAllRenderSlides(opened, fitWidthPx),
        size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
        defaultFont: deckDefaultFont(opened),
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Auto-save the draft to <Documents>/PanOffice/<name>.pptx after AI generation completes.
   * Append mode reuses the session's existing draft path (overwrite); replace mode generates a
   * new filename. On successful write, update session.path, pushRecent.
   * On write failure, degrade silently (console.warn) without blocking the in-memory session.
   */
  private async saveDraftAfterGenerate(
    session: Session,
    bytes: Uint8Array,
    mode: 'replace' | 'append',
    deckName?: string,
  ): Promise<void> {
    try {
      const draftsDir = getDraftsDir()
      // Port: no mkdir — the byte-store overlay is flat (and the Rust write_file creates no dirs)

      // Append mode: overwrite if the session already has a draft path; otherwise create a new file too
      let draftPath: string
      if (mode === 'append' && session.path && session.path.startsWith(draftsDir)) {
        draftPath = session.path
      } else {
        draftPath = await pickDraftPath(draftsDir, deckName)
      }

      await platform.writeFile(draftPath, bytes)
      session.path = draftPath
      pushRecent(draftPath)
      // Port: slidesOpenedHook (shell tab title/de-dupe) dropped — the caller returns the path
    } catch (err) {
      console.warn(
        '[slides] Failed to persist AI-generated draft to disk; the in-memory session still works:',
        err,
      )
    }
  }

  // ── Elements ─────────────────────────────────────────────────────────

  /** slides:add-element */
  async addElement(op: AddElementOp): Promise<{ slide: RenderSlide; sourceId: string } | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const paragraphs: Paragraph[] | undefined = op.paragraphs?.length
      ? (op.paragraphs as Paragraph[])
      : op.text
        ? op.text.split('\n').map((line) => ({ runs: [{ text: line }] }))
        : undefined
    const el = addElement(slide, {
      kind: op.kind,
      offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
      ...(paragraphs ? { paragraphs } : {}),
      ...(op.fillColor ? { fillColor: op.fillColor } : {}),
      ...(op.stroke
        ? {
            stroke: {
              color: op.stroke.color,
              widthEmu: Math.round(op.stroke.widthPt * EMU_PER_PT),
            },
          }
        : {}),
    })
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: el.id } : null
  }

  /** slides:delete-element */
  async deleteElement(op: DeleteElementOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    if (!slide.elements.some((x) => x.id === op.sourceId)) return null
    pushHistory(session)
    if (!deleteElement(slide, op.sourceId)) return null
    return rebuildSlide(session, op.slideIndex)
  }

  /** slides:edit-stroke */
  async editStroke(op: EditStrokeOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    if (op.groupId) {
      pushHistory(session)
      const stroke = op.stroke
        ? {
            color: op.stroke.color,
            widthEmu: Math.round(op.stroke.widthPt * EMU_PER_PT),
            ...(op.stroke.dash ? { dash: op.stroke.dash } : {}),
          }
        : null
      if (!editGroupChildStroke(slide, op.groupId, op.sourceId, stroke)) {
        session.undoStack.pop()
        return null
      }
      return rebuildSlide(session, op.slideIndex)
    }
    const el = findEl(slide, op.sourceId)
    if (!el) return null
    pushHistory(session)
    el.stroke = op.stroke
      ? {
          fill: { type: 'solid', color: op.stroke.color },
          width: Math.round(op.stroke.widthPt * EMU_PER_PT),
          ...(op.stroke.dash ? { dash: op.stroke.dash } : {}),
        }
      : undefined
    el.dirtyStroke = true
    return rebuildSlide(session, op.slideIndex)
  }

  // Mirror elements across their own axis: flipH/flipV is the only way to
  // point an arrow the other way — rotation cannot express a single-axis mirror
  /** slides:flip-elements */
  async flipElements(op: FlipElementOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const targets = op.sourceIds
      .map((id) => (op.groupId ? findGroupChild(slide, op.groupId, id)?.child : findEl(slide, id)))
      .filter((el): el is NonNullable<typeof el> => !!el)
    if (targets.length === 0) return null
    pushHistory(session)
    for (const el of targets) {
      if (op.axis === 'h') el.transform.flipH = !el.transform.flipH
      else el.transform.flipV = !el.transform.flipV
      el.dirtyTransform = true
    }
    updateConnectorsForMoved(
      slide,
      targets.map((el) => el.id),
    )
    return rebuildSlide(session, op.slideIndex)
  }

  /** slides:edit-picture-src-rect */
  async editPictureSrcRect(op: EditPictureSrcRectOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    if (!editPictureSrcRect(slide, op.sourceId, op.srcRect)) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  }

  /** slides:group-elements */
  async groupElements(op: GroupElementsOp): Promise<{ slide: RenderSlide; groupId: string } | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const result = groupElements(session.opened, op.slideIndex, op.sourceIds)
    if (!result) {
      session.undoStack.pop()
      return null
    }
    // groupElements already updated deck.slides[slideIndex] internally via materializeSlide
    const renderSlide = rebuildSlide(session, op.slideIndex)
    return renderSlide ? { slide: renderSlide, groupId: result.groupId } : null
  }

  /** slides:ungroup-element */
  async ungroupElement(op: UngroupElementOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const fresh = ungroupElement(session.opened, op.slideIndex, op.sourceId)
    if (!fresh) {
      session.undoStack.pop()
      return null
    }
    // ungroupElement already updated deck.slides[slideIndex] internally
    return rebuildSlide(session, op.slideIndex)
  }

  /** slides:edit-background */
  async editBackground(op: EditBackgroundOp): Promise<RenderSlide[] | null> {
    const session = this.requireSession()
    if (!session) return null
    const slides = session.opened.deck.slides
    const targets = op.slideIndex === -1 ? slides : [slides[op.slideIndex]].filter(Boolean)
    if (targets.length === 0) return null
    pushHistory(session)
    for (const s of targets) {
      setSlideBackground(s!, op.color)
      recolorFullBleedBackdrops(s!, session.opened.deck.size, op.color)
    }
    session.fitWidthPx = op.fitWidthPx
    return buildAllRenderSlides(session.opened, op.fitWidthPx)
  }

  /** slides:edit-image-fill */
  async editImageFill(op: {
    slideIndex: number
    sourceId: string
  }): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const picked = await pickFileBytes('.png,.jpg,.jpeg,.gif,.bmp,.webp,.tif,.tiff')
    if (!picked) return null
    const ext = picked.name.split('.').pop()!.toLowerCase()
    pushHistory(session)
    if (!setElementImageFill(session.opened, slide, op.sourceId, picked.bytes, ext)) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  }

  /** slides:insert-image */
  async insertImage(
    slideIndex: number,
    fitWidthPx: number,
  ): Promise<{ slide: RenderSlide; sourceId: string } | { error: 'unsupported'; ext: string } | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[slideIndex]
    if (!slide) return null
    const picked = await pickFileBytes('.png,.jpg,.jpeg,.gif,.bmp,.webp,.tif,.tiff')
    if (!picked) return null
    const { bytes } = picked
    const ext = picked.name.split('.').pop()!.toLowerCase()

    // Scale proportionally to at most half the page width/height, centered
    const deckSize = session.opened.deck.size
    let natural = { width: 4, height: 3 }
    if (ext === 'tif' || ext === 'tiff') {
      const decoded = tiffToPng(bytes)
      if (decoded) natural = { width: decoded.width, height: decoded.height }
    } else {
      // Port: nativeImage.createFromPath → createImageBitmap; failure keeps the 4:3 fallback
      // like upstream's isEmpty check
      try {
        const bmp = await createImageBitmap(new Blob([toArrayBuffer(bytes)]))
        if (bmp.width && bmp.height) natural = { width: bmp.width, height: bmp.height }
        bmp.close()
      } catch {
        /* keep the fallback size */
      }
    }
    const maxW = deckSize.cx / 2
    const maxH = deckSize.cy / 2
    const scale = Math.min(maxW / natural.width, maxH / natural.height)
    const cx = Math.round(natural.width * scale)
    const cy = Math.round(natural.height * scale)
    const offset = {
      x: Math.round((deckSize.cx - cx) / 2),
      y: Math.round((deckSize.cy - cy) / 2),
      cx,
      cy,
    }

    pushHistory(session)
    const el = addPicture(session.opened, slide, { bytes, ext, offset })
    if (!el) {
      session.undoStack.pop()
      return { error: 'unsupported' as const, ext }
    }
    session.fitWidthPx = fitWidthPx
    const rebuilt = rebuildSlide(session, slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: el.id } : null
  }

  /** slides:edit-fill */
  async editFill(op: EditFillOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    if (op.groupId) {
      if (typeof op.fill !== 'string') return null // Group children only support solid colors for now
      pushHistory(session)
      if (!editGroupChildFill(slide, op.groupId, op.sourceId, op.fill)) {
        session.undoStack.pop()
        return null
      }
      return rebuildSlide(session, op.slideIndex)
    }
    const el = findEl(slide, op.sourceId)
    if (!el) return null
    pushHistory(session)
    if (typeof op.fill === 'string') {
      el.fill = op.fill === 'none' ? { type: 'none' } : { type: 'solid', color: op.fill }
    } else {
      const g = op.fill.gradient
      el.fill = {
        type: 'gradient',
        stops: [
          { pos: 0, color: g.from },
          { pos: 1, color: g.to },
        ],
        ...(g.radial
          ? { path: 'circle' as const }
          : { angle: Math.round((g.angleDeg ?? 0) * 60000) }),
      }
    }
    el.dirtyFill = true
    return rebuildSlide(session, op.slideIndex)
  }

  // ── Slide add/copy/paste/delete ──────────────────────────────────────

  /** slides:add-slide */
  async addSlide(op: AddSlideOp): Promise<{ slides: RenderSlide[]; index: number } | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const slide = duplicateSlide(session.opened, op.sourceIndex, { clearText: !!op.clearText })
    if (!slide) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    return {
      slides: buildAllRenderSlides(session.opened, op.fitWidthPx),
      index: op.sourceIndex + 1,
    }
  }

  // App-wide, so a slide copied in one tab can be pasted into another deck.
  /** slides:copy-slide */
  async copySlide(slideIndex: number, pngBase64?: string): Promise<boolean> {
    const session = this.requireSession()
    if (!session) return false
    const bundle = copySlide(session.opened, slideIndex)
    if (!bundle) return false
    slideClipboard = { bundle, ...(pngBase64 ? { png: pngBase64 } : {}) }
    // Port: upstream also wrote a custom-format OS clipboard marker so plain ⌘V could rank the
    // last copy; no custom-format OS clipboard in a webview — the in-app clipboard is authoritative
    lastCopyKind = 'slide'
    return true
  }

  /** slides:has-slide-clipboard */
  async hasSlideClipboard(): Promise<boolean> {
    return slideClipboard !== null
  }

  /** slides:paste-slide */
  async pasteSlide(
    op: PasteSlideOp,
  ): Promise<{ slides: RenderSlide[]; index: number; sourceId?: string } | null> {
    const session = this.requireSession()
    if (!session || !slideClipboard) return null
    pushHistory(session)
    const r = performSlidePaste(session, op)
    if (!r) {
      session.undoStack.pop()
      return null
    }
    lastSlidePaste = { afterIndex: op.afterIndex, undoLen: session.undoStack.length }
    return r
  }

  // Paste-options floater: undo the just-completed paste and redo it with another
  // mode. Refused when anything (edits, ⌘Z) touched the deck in between.
  /** slides:repaste-slide */
  async repasteSlide(
    op: RepasteSlideOp,
  ): Promise<{ slides: RenderSlide[]; index: number; sourceId?: string } | null> {
    const session = this.requireSession()
    const rec = lastSlidePaste
    if (!session || !slideClipboard || !rec) return null
    if (session.undoStack.length !== rec.undoLen) return null
    const snap = session.undoStack.pop()
    if (!snap) return null
    restoreSnapshot(session, snap)
    pushHistory(session)
    const r = performSlidePaste(session, {
      afterIndex: rec.afterIndex,
      fitWidthPx: op.fitWidthPx,
      mode: op.mode,
    })
    if (!r) {
      session.undoStack.pop()
      return null
    }
    rec.undoLen = session.undoStack.length
    return r
  }

  /** slides:add-blank-slide */
  async addBlankSlide(op: AddBlankSlideOp): Promise<{ slides: RenderSlide[]; index: number } | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const slide = insertBlankSlide(session.opened, op.sourceIndex)
    if (!slide) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    return {
      slides: buildAllRenderSlides(session.opened, op.fitWidthPx),
      index: op.sourceIndex + 1,
    }
  }

  /** slides:add-slide-with-layout */
  async addSlideWithLayout(op: AddSlideWithLayoutOp): Promise<{ slides: RenderSlide[]; index: number } | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const slide = insertSlideWithLayout(session.opened, op.sourceIndex, op.layoutPath)
    if (!slide) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    return {
      slides: buildAllRenderSlides(session.opened, op.fitWidthPx),
      index: op.sourceIndex + 1,
    }
  }

  /** slides:get-layouts */
  async getLayouts(): Promise<GetLayoutsResult | null> {
    const session = this.requireSession()
    if (!session) return null
    const layouts = listSlideLayouts(session.opened.archive)
    return { layouts }
  }

  // ── Master edit view ───────────────────────────────────────────────
  // Exception to the fidelity rule: only parts the user actively changed in master view are
  // written back, using the same byte surgery as slides. Every commit writes the entry + fully
  // reparses all slides — inheritance takes effect immediately, and each undo snapshot's
  // (slides model, entries) pair stays self-consistent (rendering and file don't diverge after
  // undo).
  private buildMasterRenderSlide(session: Session): RenderSlide | null {
    const me = session.masterEdit
    if (!me) return null
    return buildRenderSlide(me.slide, session.opened.deck.size, {
      fitWidthPx: session.fitWidthPx,
      media: makeMediaResolver(session.opened),
      metrics: getFontMetrics(),
    })
  }

  private commitMasterEdit(session: Session): void {
    const me = session.masterEdit!
    // Port: Buffer.from(xml, 'utf8') → TextEncoder
    session.opened.archive.entries.set(me.partPath, new TextEncoder().encode(patchSlideXml(me.slide)))
    for (let i = 0; i < session.opened.deck.slides.length; i++) materializeSlide(session.opened, i)
    session.metaDirty = true
  }

  /** slides:master-enter */
  async masterEnter(fitWidthPx: number): Promise<MasterEnterResult | null> {
    const session = this.requireSession()
    if (!session) return null
    session.fitWidthPx = fitWidthPx
    const items: MasterEnterResult['items'] = []
    for (const p of listMasterParts(session.opened.archive)) {
      const slide = parseMasterPart(session.opened.archive, p.partPath)
      if (!slide) continue
      const rendered = buildRenderSlide(slide, session.opened.deck.size, {
        fitWidthPx,
        media: makeMediaResolver(session.opened),
        metrics: getFontMetrics(),
      })
      items.push({ partPath: p.partPath, kind: p.kind, name: p.name, slide: rendered })
      if (!session.masterEdit) session.masterEdit = { partPath: p.partPath, slide }
    }
    return items.length ? { items } : null
  }

  /** slides:master-open */
  async masterOpen(partPath: string): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = parseMasterPart(session.opened.archive, partPath)
    if (!slide) return null
    session.masterEdit = { partPath, slide }
    return this.buildMasterRenderSlide(session)
  }

  /** slides:master-close */
  async masterClose(): Promise<RenderSlide[] | null> {
    const session = this.requireSession()
    if (!session) return null
    session.masterEdit = null
    // Edits were materialized one by one; here we only fetch the full render tree
    return buildAllRenderSlides(session.opened, session.fitWidthPx)
  }

  /** slides:master-edit-text */
  async masterEditText(op: MasterEditTextOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    const me = session?.masterEdit
    if (!session || !me) return null
    const el = findEl(me.slide, op.sourceId)
    if (!el?.text) return null
    pushHistory(session)
    el.text.paragraphs = applyEditParagraphs(el.text.paragraphs, op.paragraphs)
    el.dirty = true
    this.commitMasterEdit(session)
    return this.buildMasterRenderSlide(session)
  }

  /** slides:master-edit-transform */
  async masterEditTransform(op: MasterEditTransformOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    const me = session?.masterEdit
    if (!session || !me) return null
    const el = me.slide.elements.find((x) => x.id === op.sourceId)
    if (!el) return null
    if (op.preview) {
      if (!session.transformPreview) {
        pushHistory(session)
        session.transformPreview = true
      }
    } else if (session.transformPreview) {
      session.transformPreview = false
    } else {
      pushHistory(session)
    }
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    el.transform = {
      ...el.transform,
      offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
      rot: Math.round(op.rotationDeg * 60000),
    }
    el.dirtyTransform = true
    // Previews are not persisted (only the final commit at drag end writes the entry + full reparse)
    if (!op.preview) this.commitMasterEdit(session)
    return this.buildMasterRenderSlide(session)
  }

  /** slides:master-edit-fill */
  async masterEditFill(op: MasterEditFillOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    const me = session?.masterEdit
    if (!session || !me) return null
    const el = findEl(me.slide, op.sourceId)
    if (!el) return null
    pushHistory(session)
    if (typeof op.fill === 'string') {
      el.fill = op.fill === 'none' ? { type: 'none' } : { type: 'solid', color: op.fill }
    } else {
      const g = op.fill.gradient
      el.fill = {
        type: 'gradient',
        stops: [
          { pos: 0, color: g.from },
          { pos: 1, color: g.to },
        ],
        ...(g.radial
          ? { path: 'circle' as const }
          : { angle: Math.round((g.angleDeg ?? 0) * 60000) }),
      }
    }
    el.dirtyFill = true
    this.commitMasterEdit(session)
    return this.buildMasterRenderSlide(session)
  }

  /** slides:master-edit-stroke */
  async masterEditStroke(op: MasterEditStrokeOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    const me = session?.masterEdit
    if (!session || !me) return null
    const el = findEl(me.slide, op.sourceId)
    if (!el) return null
    pushHistory(session)
    el.stroke = op.stroke
      ? {
          fill: { type: 'solid', color: op.stroke.color },
          width: Math.round(op.stroke.widthPt * EMU_PER_PT),
        }
      : undefined
    el.dirtyStroke = true
    this.commitMasterEdit(session)
    return this.buildMasterRenderSlide(session)
  }

  /** slides:master-delete-element */
  async masterDeleteElement(op: MasterDeleteElementOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    const me = session?.masterEdit
    if (!session || !me) return null
    if (!me.slide.elements.some((x) => x.id === op.sourceId)) return null
    pushHistory(session)
    if (!deleteElement(me.slide, op.sourceId)) {
      session.undoStack.pop()
      return null
    }
    this.commitMasterEdit(session)
    return this.buildMasterRenderSlide(session)
  }

  // ── Deck-level ops ───────────────────────────────────────────────────

  /** slides:edit-picture-opacity */
  async editPictureOpacity(op: EditPictureOpacityOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    if (!setPictureOpacity(slide, op.sourceId, op.opacity)) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  }

  /** slides:set-slide-size */
  async setSlideSize(op: SetSlideSizeOp): Promise<RenderSlide[] | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    if (!setSlideSize(session.opened, op.cx, op.cy)) {
      session.undoStack.pop()
      return null
    }
    session.metaDirty = true
    return buildAllRenderSlides(session.opened, session.fitWidthPx)
  }

  /** slides:get-slide-size */
  async getSlideSize(): Promise<{ cx: number; cy: number } | null> {
    const session = this.requireSession()
    return session ? { ...session.opened.deck.size } : null
  }

  /** slides:set-slide-layout */
  async setSlideLayout(op: SetSlideLayoutOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const r = op.layoutPath
      ? setSlideLayout(session.opened, op.slideIndex, op.layoutPath)
      : resetSlideLayout(session.opened, op.slideIndex)
    if (!r) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  }

  /** slides:find-replace */
  async findReplace(op: FindReplaceOp): Promise<{ count: number; slides: RenderSlide[] | null } | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const { count } = replaceAllInDeck(session.opened.deck, op.find, op.replace, {
      matchCase: op.matchCase,
      firstOnly: op.firstOnly,
      slideIndex: op.slideIndex,
      elementId: op.elementId,
    })
    if (!count) {
      session.undoStack.pop()
      return { count: 0, slides: null }
    }
    return { count, slides: buildAllRenderSlides(session.opened, session.fitWidthPx) }
  }

  /** slides:delete-slide */
  async deleteSlide(slideIndex: number): Promise<RenderSlide[] | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    if (!deleteSlide(session.opened, slideIndex)) {
      session.undoStack.pop()
      return null
    }
    return buildAllRenderSlides(session.opened, session.fitWidthPx)
  }

  // ── Tables ───────────────────────────────────────────────────────────

  /** slides:edit-table-cell */
  async editTableCell(op: EditTableCellOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    if (!editTableCellText(slide, op.sourceId, op.row, op.col, op.paragraphs as Paragraph[])) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  }

  /** slides:table-merge */
  async tableMerge(op: TableMergeIpcOp): Promise<{ slide: RenderSlide; sourceId: string } | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const r = mergeTableCells(session.opened, op.slideIndex, op.sourceId, {
      kind: op.kind,
      row: op.row,
      col: op.col,
    })
    if (!r) {
      session.undoStack.pop()
      return null
    }
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.elementId } : null
  }

  /** slides:table-structure */
  async tableStructure(op: TableStructureIpcOp): Promise<{ slide: RenderSlide; sourceId: string } | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const r = editTableStructure(session.opened, op.slideIndex, op.sourceId, {
      kind: op.kind,
      index: op.index,
      ...(op.before ? { before: true } : {}),
    } as TableStructureOp)
    if (!r) {
      session.undoStack.pop()
      return null
    }
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.elementId } : null
  }

  /** slides:set-table-row-height */
  async setTableRowHeight(op: SetTableRowHeightOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    pushHistory(session)
    if (!setTableRowHeight(slide, op.sourceId, op.row, (op.hPx / scale) * EMU_PER_PX_96)) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  }

  /** slides:set-table-cell-anchor */
  async setTableCellAnchor(op: SetTableCellAnchorOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    if (!setTableCellAnchor(slide, op.sourceId, op.row, op.col, op.anchor)) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  }

  /** slides:set-table-col-width */
  async setTableColWidth(op: SetTableColWidthOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    pushHistory(session)
    if (!setTableColWidth(slide, op.sourceId, op.col, (op.wPx / scale) * EMU_PER_PX_96)) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  }

  /** slides:edit-table-style */
  async editTableStyle(op: EditTableStyleOp): Promise<{ slide: RenderSlide; sourceId: string | null } | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    // A reparse regenerates element ids: look up the new id by element index; the renderer uses it to keep the selection
    const elIdx = slide.elements.findIndex((el) => el.id === op.sourceId)
    pushHistory(session)
    // Parse op -> TableStyleEdit
    let edit: TableStyleEdit
    if (op.styleName && TABLE_STYLE_PRESETS[op.styleName]) {
      const preset = TABLE_STYLE_PRESETS[op.styleName]!
      // Inject fixed-color presets' style definitions into tableStyles.xml (built-in GUIDs track theme colors, so colors would drift)
      if (preset.styleId && preset.styleDefXml) {
        ensureTableStylePart(session.opened, preset.styleId, preset.styleDefXml)
      }
      // Applying a style-gallery preset in PowerPoint clears cells' direct fills/borders; otherwise direct formatting hides the style
      edit = {
        tblPrXml: preset.tblPrXml,
        clearDirectFormatting: true,
        // Grid-style presets use direct borders (the style mechanism only has inner lines and cannot draw the outer frame)
        ...(preset.border
          ? {
              borderPreset: 'all' as const,
              borderColor: preset.border.color,
              borderWidthEmu: preset.border.widthEmu,
            }
          : {}),
      }
    } else {
      const borderColor = op.borderColor ?? undefined
      const borderWidthEmu =
        op.borderWidthPt != null ? Math.round(op.borderWidthPt * EMU_PER_PT) : undefined
      edit = {
        ...(op.firstRow !== undefined ? { firstRow: op.firstRow } : {}),
        ...(op.bandRow !== undefined ? { bandRow: op.bandRow } : {}),
        ...(op.shadingColor !== undefined ? { shadingColor: op.shadingColor } : {}),
        ...(op.borderPreset !== undefined ? { borderPreset: op.borderPreset } : {}),
        ...(borderColor !== undefined ? { borderColor } : {}),
        ...(borderWidthEmu !== undefined ? { borderWidthEmu } : {}),
        ...(op.cells ? { cells: op.cells } : {}),
      }
    }
    if (!editTableStyle(slide, op.sourceId, edit)) {
      session.undoStack.pop()
      return null
    }
    // The patch is written on anchor.originalXml; a materialize reparse is needed before it shows in the render model
    const rebuilt = rebuildSlideWithReparse(session, op.slideIndex)
    if (!rebuilt) return null
    const newId = session.opened.deck.slides[op.slideIndex]?.elements[elIdx]?.id ?? null
    return { slide: rebuilt, sourceId: newId }
  }

  // ── Charts ───────────────────────────────────────────────────────────

  /** slides:edit-chart */
  async editChart(op: EditChartOp): Promise<{ slide: RenderSlide; sourceId: string | null } | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    // A reparse regenerates element ids: look up the new id by element index; the renderer uses it to keep the selection
    const elIdx = slide.elements.findIndex((el) => el.id === op.sourceId)
    // Confirm before the first edit of a chart from an imported file: editing rebuilds it from the template,
    // and unmodeled fine-grained formatting (number formats/trendlines/error bars/per-point styles) is lost
    const chartEl = slide.elements[elIdx] as { type?: string; descr?: string } | undefined
    if (chartEl?.type === 'chart' && chartEl.descr !== 'aislides-chart') {
      // Port: native message box → window.confirm (TODO(M4): real modal dialog); cancel honored like upstream's response check
      if (!window.confirm(`${tm('chartSimplifyTitle')}\n${tm('chartSimplifyBody')}`)) return null
    }
    pushHistory(session)
    // Mark aislides-chart on first edit (the conversion itself is lossless; no re-prompt after one confirmation)
    markChartEditable(slide, op.sourceId)
    const patch: Parameters<typeof editChartElement>[3] = {
      ...(op.kind ? { kind: op.kind === 'barH' ? 'bar' : op.kind } : {}),
      ...(op.kind === 'barH' ? { barDir: 'bar' as const } : {}),
      ...(op.categories ? { categories: op.categories } : {}),
      ...(op.series ? { series: op.series } : {}),
      ...(op.title !== undefined ? { title: op.title } : {}),
      ...(op.colorScheme
        ? {
            colorScheme:
              chartColorSchemes(session.opened).find((s) => s.key === op.colorScheme)?.colors ??
              CHART_COLOR_SCHEMES[op.colorScheme],
          }
        : {}),
      ...(op.legendPos ? { legendPos: op.legendPos } : {}),
      ...(op.dataLabels !== undefined ? { dataLabels: op.dataLabels } : {}),
      ...(op.gridlines !== undefined ? { gridlines: op.gridlines } : {}),
      ...(op.catAxisTitle !== undefined ? { catAxisTitle: op.catAxisTitle } : {}),
      ...(op.valAxisTitle !== undefined ? { valAxisTitle: op.valAxisTitle } : {}),
      ...(op.gapWidthPct !== undefined ? { gapWidthPct: op.gapWidthPct } : {}),
      ...(op.switchRowCol ? { switchRowCol: true } : {}),
      ...(op.pointColors ? { pointColors: op.pointColors } : {}),
    }
    if (!editChartElement(session.opened, op.slideIndex, op.sourceId, patch)) {
      session.undoStack.pop()
      return null
    }
    // The chart part XML is updated; reparse the whole page to refresh the model
    const rebuilt = rebuildSlideWithReparse(session, op.slideIndex)
    if (!rebuilt) return null
    const newId = session.opened.deck.slides[op.slideIndex]?.elements[elIdx]?.id ?? null
    return { slide: rebuilt, sourceId: newId }
  }

  /** slides:chart-color-schemes */
  async getChartColorSchemes(): Promise<Array<{ key: string; label: string; colors: string[] }> | null> {
    const session = this.requireSession()
    return session ? chartColorSchemes(session.opened) : null
  }

  /** slides:get-chart-data */
  async getChartData(
    slideIndex: number,
    sourceId: string,
  ): Promise<{
    kind: string
    title: string
    categories: string[]
    series: Array<{ name: string; values: number[] }>
    seriesColors: Array<string | undefined>
    pointColors: Array<Array<string | undefined> | undefined>
  } | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[slideIndex]
    if (!slide) return null
    return getChartElementData(slide, sourceId)
  }

  /** slides:reorder-element */
  async reorderElement(op: ReorderElementOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    if (!reorderElement(slide, op.sourceId, op.dir)) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  }

  /** slides:set-text-anchor */
  async setTextAnchor(op: {
    slideIndex: number
    sourceId: string
    anchor: 'top' | 'middle' | 'bottom'
  }): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    if (!setElementTextAnchor(slide, op.sourceId, op.anchor)) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  }

  // ── Clipboard ────────────────────────────────────────────────────────

  /** slides:clipboard-external */
  async clipboardExternal(): Promise<
    | { kind: 'internal' }
    | { kind: 'slide' }
    | { kind: 'image'; base64: string; ext: string }
    | { kind: 'text'; text: string }
    | { kind: 'none' }
  > {
    // The last in-app copy wins (upstream ranked via custom-format OS clipboard markers —
    // a webview has none, so the in-app clipboard is authoritative; TODO M4)
    if (lastCopyKind === 'slide' && slideClipboard) return { kind: 'slide' }
    if (lastCopyKind === 'elements' && elementClipboard?.items.length) return { kind: 'internal' }
    // OS clipboard: image first, then text. Permission denials fall through to the
    // text-less path like upstream's empty reads.
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'))
        if (!type) continue
        const blob = await item.getType(type)
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const ext = type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] ?? 'png')
        return { kind: 'image', base64: bytesToBase64(bytes), ext }
      }
    } catch {
      /* denied or unsupported — fall through */
    }
    try {
      const text = await navigator.clipboard.readText()
      if (text.trim()) return { kind: 'text', text }
    } catch {
      /* denied — fall through */
    }
    return { kind: 'none' }
  }

  /** slides:copy-elements */
  async copyElements(op: CopyElementsOp): Promise<number> {
    const session = this.requireSession()
    if (!session) return 0
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return 0
    const items = op.sourceIds
      .map((id) => slide.elements.find((el) => el.id === id))
      .filter((el): el is NonNullable<typeof el> => !!el)
      .map((el) => copyElementData(session.opened, slide, el))
    if (items.length) {
      elementClipboard = { items, pasteCount: 0 }
      // Port: upstream wrote a custom-format OS marker (an external copy overwrote it, so paste
      // time could tell internal from external); no custom-format OS clipboard in a webview
      lastCopyKind = 'elements'
    }
    return items.length
  }

  /** slides:paste-elements */
  async pasteElements(op: PasteElementsOp): Promise<{ slide: RenderSlide; sourceIds: string[] } | null> {
    const session = this.requireSession()
    const clip = elementClipboard
    if (!session || !clip?.items.length) return null
    if (!session.opened.deck.slides[op.slideIndex]) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    // Cascading offset: each paste shifts another 16px relative to the original
    const shift = Math.round(((16 * (clip.pasteCount + 1)) / scale) * EMU_PER_PX_96)
    pushHistory(session)
    const r = pasteElements(session.opened, op.slideIndex, clip.items, { dx: shift, dy: shift })
    if (!r) {
      session.undoStack.pop()
      return null
    }
    clip.pasteCount++
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceIds: r.elementIds } : null
  }

  // Duplicate in place (⌘D / Option+drag copy): does not touch the app clipboard; the caller supplies the offset
  /** slides:duplicate-elements */
  async duplicateElements(op: DuplicateElementsOp): Promise<{ slide: RenderSlide; sourceIds: string[] } | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const items = op.sourceIds
      .map((id) => slide.elements.find((el) => el.id === id))
      .filter((el): el is NonNullable<typeof el> => !!el)
      .map((el) => copyElementData(session.opened, slide, el))
    if (!items.length) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    pushHistory(session)
    const r = pasteElements(session.opened, op.slideIndex, items, {
      dx: toEmu(op.dxPx),
      dy: toEmu(op.dyPx),
    })
    if (!r) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceIds: r.elementIds } : null
  }

  /** slides:add-table */
  async addTable(op: AddTableOp): Promise<{ slide: RenderSlide; sourceId: string } | null> {
    const session = this.requireSession()
    if (!session) return null
    if (!session.opened.deck.slides[op.slideIndex]) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    pushHistory(session)
    const r = addTable(session.opened, op.slideIndex, {
      rows: op.rows,
      cols: op.cols,
      offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
    })
    if (!r) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.elementId } : null
  }

  // Freehand ink stroke commit: one transparent PNG picture element per stroke (cNvPr name has
  // the aislides-ink prefix, descr stores the vector points as JSON); undo/save/thumbnails all
  // go through the existing picture-element pipeline.
  /** slides:add-ink */
  async addInk(op: AddInkOp): Promise<{ slide: RenderSlide; sourceId: string } | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    pushHistory(session)
    const el = addPicture(session.opened, slide, {
      bytes: base64ToBytes(op.base64),
      ext: 'png',
      offset: {
        x: toEmu(op.xPx),
        y: toEmu(op.yPx),
        cx: Math.max(1, toEmu(op.wPx)),
        cy: Math.max(1, toEmu(op.hPx)),
      },
      name: `aislides-ink ${Date.now().toString(36)}`,
      descr: op.payload,
    })
    if (!el) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: el.id } : null
  }

  // ── New insert capabilities: charts / SmartArt / icon bitmaps / audio-video / 3D / links / header-footer ──

  /** slides:add-chart */
  async addChart(op: AddChartOp): Promise<{ slide: RenderSlide; sourceId: string } | null> {
    const session = this.requireSession()
    if (!session || !session.opened.deck.slides[op.slideIndex]) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    pushHistory(session)
    const r = addChart(session.opened, op.slideIndex, {
      kind: op.kind === 'barH' ? 'bar' : op.kind,
      ...(op.kind === 'barH' ? { barDir: 'bar' as const } : {}),
      ...(op.title ? { title: op.title } : {}),
      categories: op.categories,
      series: op.series,
      offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
    })
    if (!r) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.elementId } : null
  }

  /** slides:add-smartart */
  async addSmartArt(op: AddSmartArtOp): Promise<{ slide: RenderSlide; sourceId: string } | null> {
    const session = this.requireSession()
    if (!session || !session.opened.deck.slides[op.slideIndex]) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    pushHistory(session)
    const r = addSmartArt(session.opened, op.slideIndex, {
      layout: op.layout,
      items: op.items,
      offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
    })
    if (!r) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: r.elementId } : null
  }

  /** slides:add-image-bytes */
  async addImageBytes(
    op: AddImageBytesOp,
  ): Promise<{ slide: RenderSlide; sourceId: string } | { error: 'unsupported'; ext: string } | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const scale = op.fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    pushHistory(session)
    const el = addPicture(session.opened, slide, {
      bytes: base64ToBytes(op.base64),
      ext: op.ext,
      offset: {
        x: toEmu(op.xPx),
        y: toEmu(op.yPx),
        cx: Math.max(1, toEmu(op.wPx)),
        cy: Math.max(1, toEmu(op.hPx)),
      },
      ...(op.name ? { name: op.name } : {}),
    })
    if (!el) {
      session.undoStack.pop()
      return { error: 'unsupported' as const, ext: op.ext }
    }
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: el.id } : null
  }

  // Show a dialog to pick video/audio and embed it.
  // Port: the poster frame prefers a system thumbnail upstream (QuickLook via
  // nativeImage.createThumbnailFromPath); a webview has no thumbnail API, so the poster is
  // skipped — upstream's catch path did the same (addMedia falls back to a solid color).
  /** slides:insert-media */
  async insertMedia(
    slideIndex: number,
    kind: 'video' | 'audio',
    fitWidthPx: number,
  ): Promise<{ slide: RenderSlide; sourceId: string } | null> {
    const session = this.requireSession()
    if (!session || !session.opened.deck.slides[slideIndex]) return null
    const accept = kind === 'video' ? '.mp4,.m4v,.mov,.webm,.avi' : '.mp3,.wav,.m4a,.aac,.ogg'
    const picked = await pickFileBytes(accept)
    if (!picked) return null
    const { bytes } = picked
    const ext = picked.name.split('.').pop()!.toLowerCase()
    const fileName = picked.name.split('/').pop()!

    // Warn up front when in-app playback will be broken — AVI has no
    // Chromium demuxer at all; mp4/m4v/mov with e.g. AC-3/DTS audio plays silent.
    if (kind === 'video') {
      let detail: string | null = null
      if (ext === 'avi') detail = tm('mediaAviBody')
      else if (ext === 'mp4' || ext === 'm4v' || ext === 'mov') {
        const codec = unplayableAudioCodec(bytes)
        if (codec) detail = tm('mediaNoAudioBody', { codec })
      }
      if (detail) {
        // TODO(M4): real modal dialog
        console.warn('[slides]', `${tm('mediaUnsupportedTitle')}\n${detail}`)
      }
    }

    const deckSize = session.opened.deck.size
    const offset =
      kind === 'video'
        ? (() => {
            const cx = Math.round(deckSize.cx * 0.6)
            const cy = Math.round((cx * 9) / 16)
            return {
              x: Math.round((deckSize.cx - cx) / 2),
              y: Math.round((deckSize.cy - cy) / 2),
              cx,
              cy,
            }
          })()
        : (() => {
            const cx = Math.round(deckSize.cx * 0.24)
            const cy = Math.round(deckSize.cy * 0.09)
            return {
              x: Math.round((deckSize.cx - cx) / 2),
              y: Math.round((deckSize.cy - cy) / 2),
              cx,
              cy,
            }
          })()

    pushHistory(session)
    const added = addMedia(session.opened, slideIndex, {
      kind,
      bytes,
      ext,
      offset,
      name: fileName,
    })
    if (!added) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = fitWidthPx
    const rebuilt = rebuildSlide(session, slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: added.elementId } : null
  }

  // Double-click playback: read the media bytes of an audio/video element (embedded converts to dataUrl, external links return as-is)
  /** slides:media-data */
  async getMediaData(
    slideIndex: number,
    sourceId: string,
  ): Promise<{ kind: 'video' | 'audio'; dataUrl: string } | null> {
    const session = this.requireSession()
    const slide = session?.opened.deck.slides[slideIndex]
    if (!session || !slide) return null
    const el = slide.elements.find((x) => x.id === sourceId)
    if (!el || el.type !== 'picture') return null
    const media = (
      el as { media?: { kind: 'video' | 'audio'; target?: string; external?: boolean } }
    ).media
    if (!media?.target) return null
    if (media.external) return { kind: media.kind, dataUrl: media.target }
    const bytes = session.opened.archive.readBytes(media.target)
    if (!bytes) return null
    const ext = media.target.split('.').pop()?.toLowerCase() ?? ''
    const mime = AV_MIME[ext] ?? (media.kind === 'video' ? 'video/mp4' : 'audio/mpeg')
    return {
      kind: media.kind,
      dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}`,
    }
  }

  // Media recorded by the renderer (screen-recording webm): placed centered at 16:9
  /** slides:add-media-bytes */
  async addMediaBytes(op: AddMediaBytesOp): Promise<{ slide: RenderSlide; sourceId: string } | null> {
    const session = this.requireSession()
    if (!session || !session.opened.deck.slides[op.slideIndex]) return null
    const deckSize = session.opened.deck.size
    const cx = Math.round(deckSize.cx * 0.6)
    const cy = Math.round((cx * 9) / 16)
    pushHistory(session)
    const added = addMedia(session.opened, op.slideIndex, {
      kind: op.kind,
      bytes: base64ToBytes(op.base64),
      ext: op.ext,
      offset: {
        x: Math.round((deckSize.cx - cx) / 2),
        y: Math.round((deckSize.cy - cy) / 2),
        cx,
        cy,
      },
      ...(op.name ? { name: op.name } : {}),
    })
    if (!added) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    const rebuilt = rebuildSlide(session, op.slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: added.elementId } : null
  }

  // 3D model (simplified): glb embed + poster placeholder image
  // Port: no thumbnail API in a webview — poster skipped (upstream's failure path did the same)
  /** slides:insert-model3d */
  async insertModel3d(
    slideIndex: number,
    fitWidthPx: number,
  ): Promise<{ slide: RenderSlide; sourceId: string } | null> {
    const session = this.requireSession()
    if (!session || !session.opened.deck.slides[slideIndex]) return null
    const picked = await pickFileBytes('.glb,.gltf')
    if (!picked) return null
    const { bytes } = picked
    const ext = picked.name.split('.').pop()!.toLowerCase()

    const deckSize = session.opened.deck.size
    const cy = Math.round(deckSize.cy * 0.5)
    const cx = cy
    pushHistory(session)
    const added = addModel3d(session.opened, slideIndex, {
      bytes,
      ext,
      offset: {
        x: Math.round((deckSize.cx - cx) / 2),
        y: Math.round((deckSize.cy - cy) / 2),
        cx,
        cy,
      },
      name: picked.name.split('/').pop()!,
    })
    if (!added) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = fitWidthPx
    const rebuilt = rebuildSlide(session, slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: added.elementId } : null
  }

  // ── Links / header-footer / theme ────────────────────────────────────

  /** slides:set-link */
  async setLink(op: SetLinkOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session || !session.opened.deck.slides[op.slideIndex]) return null
    pushHistory(session)
    const fresh = setElementLink(session.opened, op.slideIndex, op.sourceId, op.target)
    if (!fresh) {
      session.undoStack.pop()
      return null
    }
    return rebuildSlide(session, op.slideIndex)
  }

  /** slides:get-link */
  async getLink(slideIndex: number, sourceId: string): Promise<LinkTargetOp | null> {
    const session = this.requireSession()
    if (!session) return null
    return getElementLink(session.opened, slideIndex, sourceId)
  }

  /** slides:get-slide-links */
  async getSlideLinks(slideIndex: number): Promise<Array<{ sourceId: string; target: LinkTargetOp }>> {
    const session = this.requireSession()
    if (!session) return []
    return getSlideLinks(session.opened, slideIndex).map(({ elementId, target }) => ({
      sourceId: elementId,
      target,
    }))
  }

  /** slides:get-run-links */
  async getRunLinks(
    slideIndex: number,
  ): Promise<Array<{ sourceId: string; paraIndex: number; runIndex: number; target: LinkTargetOp }>> {
    const session = this.requireSession()
    if (!session) return []
    return getRunLinks(session.opened, slideIndex).map(({ elementId, ...rest }) => ({
      sourceId: elementId,
      ...rest,
    }))
  }

  /** slides:apply-header-footer */
  async applyHeaderFooter(op: HeaderFooterOp): Promise<RenderSlide[] | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const changed = applyHeaderFooter(session.opened, {
      footer: op.footer ?? null,
      slideNum: !!op.slideNum,
      date: op.date ?? null,
      ...(op.dateAuto ? { dateAuto: true } : {}),
    })
    if (!changed) {
      session.undoStack.pop()
      return null
    }
    session.fitWidthPx = op.fitWidthPx
    return buildAllRenderSlides(session.opened, op.fitWidthPx)
  }

  /** slides:get-header-footer */
  async getHeaderFooter(
    slideIndex: number,
  ): Promise<{ footer: string | null; slideNum: boolean; date: string | null }> {
    const session = this.requireSession()
    const slide = session?.opened.deck.slides[slideIndex]
    return slide ? readHeaderFooter(slide) : { footer: null, slideNum: false, date: null }
  }

  // Apply a theme (Design tab theme gallery): rewrite theme*.xml colors/fonts (scheme-referenced
  // colors follow), and remap the deck's explicit srgbClr wholesale to the new theme palette
  // (real-world decks have almost entirely explicit colors, so swapping only the theme changes
  // nothing visually). Element resolved colors come from the parse-time inheritance chain, so
  // after the surgery savePptx -> openPptx reparses; undo snapshots roll back as usual.
  /** slides:apply-theme */
  async applyTheme(op: ApplyThemeOp): Promise<RenderSlide[] | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const spec = {
      name: op.name,
      colors: op.colors,
      ...(op.majorFont ? { majorFont: op.majorFont } : {}),
      ...(op.minorFont ? { minorFont: op.minorFont } : {}),
    }
    try {
      // 1) Bake unsaved edits into the package bytes first: the color surgery edits entries
      //    directly, and dirty elements left for a later save would overwrite the surgery
      //    result with stale slices
      session.opened = await openPptx(await savePptx(session.opened))
      // 2) Pure entry surgery: theme parts + explicit color remapping
      const patched = applyThemeToArchive(session.opened, spec)
      const remapped = remapDeckColors(session.opened, spec)
      if (patched === 0 && remapped === 0) {
        session.undoStack.pop()
        return null
      }
      // 3) Reopen and reparse so every element's resolved colors/fonts refresh
      session.opened = await openPptx(await savePptx(session.opened))
    } catch {
      restoreSnapshot(session, session.undoStack.pop()!)
      return null
    }
    // Pages without any background definition fall back to the theme base color (so dark themes don't leave a white background)
    const lt1 = op.colors.lt1
    if (lt1) {
      for (const s of session.opened.deck.slides) {
        if (!s.background) setSlideBackground(s, `#${lt1.replace(/^#/, '')}`)
      }
    }
    // Reopening cleared element-level dirty; the session-level flag preserves the "unsaved" state (reset on save)
    session.metaDirty = true
    session.fitWidthPx = op.fitWidthPx
    return buildAllRenderSlides(session.opened, op.fitWidthPx)
  }

  /** ai:insert-image-url — the only AI IPC that edits the deck, so it lives in the host */
  async insertImageUrl(op: {
    slideIndex: number
    url: string
    xPx: number
    yPx: number
    wPx: number
    hPx: number
    fitWidthPx: number
  }): Promise<{ slide: RenderSlide; sourceId: string } | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    try {
      // the URL originates from AI tool calls (prompt-injectable via image
      // search results), so refuse non-http schemes.
      // Port: upstream's SSRF guard also blocked private/link-local targets and validated every
      // redirect hop; the webview's fetch can't observe remote addresses (CORS applies instead)
      const url = String(op.url)
      if (!/^https?:\/\//i.test(url)) return null
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      })
      if (!resp.ok) return null
      const bytes = new Uint8Array(await resp.arrayBuffer())
      const ct = resp.headers.get('content-type') ?? ''
      const ext = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : 'jpg'
      const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
      const scale = op.fitWidthPx / baseWidthPx
      const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
      pushHistory(session)
      const el = addPicture(session.opened, slide, {
        bytes,
        ext,
        offset: {
          x: toEmu(op.xPx),
          y: toEmu(op.yPx),
          cx: Math.max(1, toEmu(op.wPx)),
          cy: Math.max(1, toEmu(op.hPx)),
        },
      })
      if (!el) {
        session.undoStack.pop()
        return null
      }
      session.fitWidthPx = op.fitWidthPx
      const rebuilt = rebuildSlide(session, op.slideIndex)
      return rebuilt ? { slide: rebuilt, sourceId: el.id } : null
    } catch {
      return null
    }
  }

  // ── Transitions / animations ─────────────────────────────────────────

  /** slides:set-transition */
  async setTransition(op: SetTransitionOp): Promise<boolean> {
    const session = this.requireSession()
    if (!session) return false
    const slides = session.opened.deck.slides
    const targets = op.slideIndex === -1 ? slides : [slides[op.slideIndex]].filter(Boolean)
    if (targets.length === 0) return false
    pushHistory(session)
    for (const s of targets) setSlideTransition(s!, op.kind)
    return true
  }

  /** slides:get-transition */
  async getTransition(slideIndex: number): Promise<TransitionKind> {
    const session = this.requireSession()
    const slide = session?.opened.deck.slides[slideIndex]
    return slide ? getSlideTransition(slide) : 'none'
  }

  // Rehearsal timing save: batch-write each page's auto-advance time (<p:transition advTm>, ms)
  /** slides:set-advance-times */
  async setAdvanceTimes(op: SetAdvanceTimesOp): Promise<boolean> {
    const session = this.requireSession()
    if (!session) return false
    const slides = session.opened.deck.slides
    const targets = op.times.filter((t) => slides[t.slideIndex])
    if (targets.length === 0) return false
    pushHistory(session)
    for (const t of targets) setSlideAdvanceTime(slides[t.slideIndex]!, t.ms)
    return true
  }

  // ── Shape animations (<p:timing>; the spid <-> temporary element id mapping happens here) ──
  /** slides:get-animations */
  async getAnimations(slideIndex: number): Promise<AnimationItem[]> {
    const session = this.requireSession()
    const slide = session?.opened.deck.slides[slideIndex]
    if (!slide) return []
    const bySpid = new Map<number, (typeof slide.elements)[number]>()
    for (const el of slide.elements) {
      const spid = elementSpid(el)
      if (spid != null && !bySpid.has(spid)) bySpid.set(spid, el)
    }
    const typeLabel: Record<string, string> = {
      text: tm('labelTextBox'),
      shape: tm('labelShape'),
      picture: tm('labelPicture'),
      group: tm('labelGroup'),
      table: tm('labelTable'),
      chart: tm('labelChart'),
      passthrough: tm('labelObject'),
    }
    const out: AnimationItem[] = []
    for (const a of getSlideAnimations(slide)) {
      const el = bySpid.get(a.spid)
      if (!el) continue // Leftover animations whose target shape was deleted are not echoed back
      out.push({
        sourceId: el.id,
        targetName: el.name || typeLabel[el.type] || tm('labelObject'),
        effect: a.effect,
        trigger: a.trigger,
        durationMs: a.durationMs,
        delayMs: a.delayMs,
        ...(a.motionPath != null ? { motionPath: a.motionPath } : {}),
        ...(a.paragraph != null ? { paragraph: a.paragraph } : {}),
      })
    }
    return out
  }

  // Pairing keys for Morph transitions: sourceId changes on every reparse, so match across pages by cNvPr id/name
  /** slides:get-shape-keys */
  async getShapeKeys(slideIndex: number): Promise<ShapeKey[]> {
    const session = this.requireSession()
    const slide = session?.opened.deck.slides[slideIndex]
    if (!slide) return []
    return slide.elements.map((el) => ({
      sourceId: el.id,
      spid: elementSpid(el),
      name: el.name ?? '',
    }))
  }

  /** slides:set-animations */
  async setAnimations(op: SetAnimationsOp): Promise<boolean> {
    const session = this.requireSession()
    const slide = session?.opened.deck.slides[op.slideIndex]
    if (!session || !slide) return false
    const anims: SlideAnimation[] = []
    for (const it of op.items) {
      const el = slide.elements.find((x) => x.id === it.sourceId)
      const spid = el ? elementSpid(el) : null
      if (spid == null) continue
      anims.push({
        spid,
        effect: it.effect,
        trigger: it.trigger,
        durationMs: Math.max(0, Math.round(it.durationMs)),
        delayMs: Math.max(0, Math.round(it.delayMs)),
        ...(it.motionPath != null ? { motionPath: it.motionPath } : {}),
        ...(it.paragraph != null ? { paragraph: it.paragraph } : {}),
      })
    }
    pushHistory(session)
    setSlideAnimations(slide, anims)
    return true
  }

  /** slides:set-hidden */
  async setSlideHidden(op: SetSlideHiddenOp): Promise<RenderSlide | null> {
    const session = this.requireSession()
    if (!session) return null
    const slide = session.opened.deck.slides[op.slideIndex]
    if (!slide) return null
    pushHistory(session)
    setSlideHidden(slide, op.hidden)
    return rebuildSlide(session, op.slideIndex)
  }

  // ── Section management: presentation.xml surgery, riding on snapshot undo and savePptx ──

  /** slides:get-sections */
  async getSections(): Promise<SectionInfo[]> {
    const session = this.requireSession()
    return session ? getSections(session.opened) : []
  }

  /** slides:set-sections */
  async setSections(sections: SectionInfo[]): Promise<SectionInfo[] | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    setSections(session.opened, sections)
    session.metaDirty = true
    return getSections(session.opened)
  }

  /** slides:add-section */
  async addSection(op: AddSectionOp): Promise<SectionInfo[] | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const r = addSection(session.opened, op.atSlideIndex, op.name)
    if (!r) {
      session.undoStack.pop()
      return null
    }
    session.metaDirty = true
    return r
  }

  /** slides:rename-section */
  async renameSection(op: RenameSectionOp): Promise<SectionInfo[] | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const r = renameSection(session.opened, op.id, op.name)
    if (!r) {
      session.undoStack.pop()
      return null
    }
    session.metaDirty = true
    return r
  }

  /** slides:remove-section */
  async removeSection(op: RemoveSectionOp): Promise<SectionInfo[] | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const r = removeSection(session.opened, op.id, { keepSlides: true })
    if (!r) {
      session.undoStack.pop()
      return null
    }
    session.metaDirty = true
    return r
  }

  // Drag to reorder slides (sldIdLst + deck.slides + section membership); must send back the full RenderSlide set
  /** slides:move-slide */
  async moveSlide(op: MoveSlideOp): Promise<{ slides: RenderSlide[]; sections: SectionInfo[] } | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    if (!moveSlide(session.opened, op.fromIndex, op.toIndex)) {
      session.undoStack.pop()
      return null
    }
    session.metaDirty = true
    return {
      slides: buildAllRenderSlides(session.opened, session.fitWidthPx),
      sections: getSections(session.opened),
    }
  }

  // Moving a whole section changes slide order (sldIdLst + deck.slides); must send back the full RenderSlide set
  /** slides:move-section */
  async moveSection(op: MoveSectionOp): Promise<{ slides: RenderSlide[]; sections: SectionInfo[] } | null> {
    const session = this.requireSession()
    if (!session) return null
    pushHistory(session)
    const sections = moveSection(session.opened, op.id, op.dir)
    if (!sections) {
      session.undoStack.pop()
      return null
    }
    session.metaDirty = true
    return {
      slides: buildAllRenderSlides(session.opened, session.fitWidthPx),
      sections,
    }
  }

  // ── Speaker notes / comments (archive surgery, riding on snapshot undo and savePptx) ────

  /** slides:get-notes */
  async getNotes(slideIndex: number): Promise<string> {
    const session = this.requireSession()
    const slide = session?.opened.deck.slides[slideIndex]
    return session && slide ? getSlideNotes(session.opened.archive, slide.path) : ''
  }

  /** slides:set-notes */
  async setNotes(op: SetNotesOp): Promise<boolean> {
    const session = this.requireSession()
    if (!session || !session.opened.deck.slides[op.slideIndex]) return false
    pushHistory(session)
    const ok = setSlideNotes(session.opened, op.slideIndex, op.text)
    if (!ok) session.undoStack.pop()
    else session.metaDirty = true
    return ok
  }

  /** slides:get-comments */
  async getComments(slideIndex: number): Promise<SlideComment[]> {
    const session = this.requireSession()
    const slide = session?.opened.deck.slides[slideIndex]
    return session && slide ? getSlideComments(session.opened.archive, slide.path) : []
  }

  /** slides:add-comment */
  async addComment(op: AddCommentOp): Promise<SlideComment[] | null> {
    const session = this.requireSession()
    const slide = session?.opened.deck.slides[op.slideIndex]
    if (!session || !slide) return null
    pushHistory(session)
    const author = commentAuthorName()
    const added = addSlideComment(session.opened, op.slideIndex, { author, text: op.text })
    if (!added) {
      session.undoStack.pop()
      return null
    }
    session.metaDirty = true
    return getSlideComments(session.opened.archive, slide.path)
  }

  /** slides:delete-comment */
  async deleteComment(op: DeleteCommentOp): Promise<SlideComment[] | null> {
    const session = this.requireSession()
    const slide = session?.opened.deck.slides[op.slideIndex]
    if (!session || !slide) return null
    pushHistory(session)
    if (
      !deleteSlideComment(session.opened, op.slideIndex, { authorId: op.authorId, idx: op.idx })
    ) {
      session.undoStack.pop()
      return null
    }
    session.metaDirty = true
    return getSlideComments(session.opened.archive, slide.path)
  }

  // System clipboard while text-editing (menu commands are echoed back by the renderer per context)
  /** slides:native-clipboard */
  async nativeClipboard(op: 'cut' | 'copy' | 'paste'): Promise<void> {
    // Port: webContents.cut/copy/paste → document.execCommand (deprecated but the only
    // in-webview equivalent; 'paste' is commonly refused — best-effort, returns void either way)
    try {
      document.execCommand(op)
    } catch {
      /* best-effort */
    }
  }

  // ── History ──────────────────────────────────────────────────────────

  /** slides:history-batch-begin */
  async beginHistoryBatch(): Promise<boolean> {
    const session = this.requireSession()
    if (!session) return false
    beginHistoryBatch(session)
    return true
  }

  /** slides:history-batch-end */
  async endHistoryBatch(): Promise<number | null> {
    const session = this.requireSession()
    if (!session) return null
    const before = endHistoryBatch(session)
    return before ? registerAiSnapshot(session, before) : null
  }

  /** slides:ai-snapshot-restore */
  async aiSnapshotRestore(id: number): Promise<RenderSlide[] | null> {
    const session = this.requireSession()
    if (!session || session.masterEdit || session.historyBatch) return null
    if (!restoreAiSnapshot(session, id)) return null
    return buildAllRenderSlides(session.opened, session.fitWidthPx)
  }

  /** slides:undo */
  async undo(): Promise<RenderSlide[] | null> {
    const session = this.requireSession()
    // Undo disabled in master view: the masterEdit.slide model cannot roll back with snapshots (v1 trade-off; undoable after exiting)
    if (!session || session.masterEdit) return null
    settleStaleHistoryBatch(session)
    if (session.undoStack.length === 0) return null
    session.redoStack.push(takeSnapshot(session))
    restoreSnapshot(session, session.undoStack.pop()!)
    return buildAllRenderSlides(session.opened, session.fitWidthPx)
  }

  /** slides:redo */
  async redo(): Promise<RenderSlide[] | null> {
    const session = this.requireSession()
    if (!session || session.masterEdit) return null
    settleStaleHistoryBatch(session)
    if (session.redoStack.length === 0) return null
    session.undoStack.push(takeSnapshot(session))
    restoreSnapshot(session, session.redoStack.pop()!)
    return buildAllRenderSlides(session.opened, session.fitWidthPx)
  }

  /** slides:is-dirty */
  async isDirty(): Promise<boolean> {
    const session = this.requireSession()
    if (!session) return false
    return sessionDirty(session)
  }

  /** slides:autosave-pref — mirror the renderer's autosave toggle (close guard is bridge-level TODO M4) */
  setAutoSavePref(on: boolean): void {
    this.autoSavePref = on === true
  }

  // ── Save ─────────────────────────────────────────────────────────────

  /** slides:save */
  async save(): Promise<{ ok: boolean; path?: string; error?: string; slides?: RenderSlide[] }> {
    const session = this.requireSession()
    if (!session) return { ok: false, error: 'no file open' }
    // Untitled (new blank file): the first save lands silently in the drafts folder (Save As keeps its dialog)
    if (!session.path) {
      // Port: no mkdir — the byte-store overlay is flat
      session.path = await pickDraftPath(getDraftsDir(), tm('untitledDeck'))
      pushRecent(session.path)
      // Port: slidesOpenedHook (shell tab title) dropped — the new path returns to the renderer here
    }
    try {
      // Port: savePptxToFile needs node:fs — serialize in-memory and write through the byte-store
      const bytes = await savePptx(session.opened)
      await platform.writeFile(session.path, bytes)
      autosaveBackoff.delete(session.path)
      void platform.deleteFile(autosavePathFor(session.path)).catch(() => {})
      dropUntitledRecovery()
      // Bake the saved patches back into the in-memory model (clears dirty, syncs
      // anchor.originalXml with disk) — a full reopen would re-read and unzip the
      // whole package, doubling save latency on large decks. Element ids survive,
      // but the renderer still expects the render tree in the response.
      commitSaved(session.opened)
      session.metaDirty = false
      return {
        ok: true,
        path: session.path,
        slides: buildAllRenderSlides(session.opened, session.fitWidthPx),
      }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  /** slides:save-as */
  async saveAs(
    defaultName: string,
  ): Promise<{ ok: boolean; path?: string; error?: string; slides?: RenderSlide[] }> {
    const session = this.requireSession()
    if (!session) return { ok: false, error: 'no file open' }
    if (isTauri()) {
      // TODO(M4): native save dialog (tauri plugin-dialog) + write to the picked path
      return { ok: false, error: 'save-as dialog not implemented on tauri yet (TODO M4)' }
    }
    // Browser: no save dialog — persist under the chosen name in the overlay AND trigger a
    // download (like the docs port's saveDocxAs). There is no cancel path without a dialog.
    try {
      const bytes = await savePptx(session.opened)
      await platform.writeFile(defaultName, bytes)
      triggerDownload(defaultName, bytes, PPTX_MIME)
      session.path = defaultName
      autosaveBackoff.delete(defaultName)
      dropUntitledRecovery()
      pushRecent(defaultName)
      // Port: slidesOpenedHook dropped — the new path returns to the renderer here
      commitSaved(session.opened)
      session.metaDirty = false
      return {
        ok: true,
        path: defaultName,
        slides: buildAllRenderSlides(session.opened, session.fitWidthPx),
      }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  // ── Export (PDF / images): the renderer renders hi-res PNGs with offscreen Konva; the host handles dialogs/writing ──

  /** slides:pick-export-dir */
  pickExportDir(): Promise<string | null> {
    // TODO(M4): no directory picker in a webview — report cancel like upstream's canceled dialog
    return Promise.resolve(null)
  }

  /** slides:export-images */
  async exportImages(op: ExportImagesOp): Promise<ExportImagesResult> {
    if (isTauri()) {
      // TODO(M4): native directory picker + write
      return { ok: false, error: 'image export needs a Tauri-side implementation (TODO M4)' }
    }
    try {
      // Zero-padding width follows the total page count (3 digits for ≥100 pages)
      const pad = op.pngsBase64.length >= 100 ? 3 : 2
      // Port: without a directory picker there is no target dir — one browser download per PNG
      for (let i = 0; i < op.pngsBase64.length; i++) {
        const name = `${op.baseName}-${String(i + 1).padStart(pad, '0')}.png`
        triggerDownload(name, base64ToBytes(op.pngsBase64[i]!), 'image/png')
      }
      return { ok: true, paths: [] }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  /** slides:pick-export-pdf-path */
  pickExportPdfPath(_defaultName: string): Promise<string | null> {
    // TODO(M4): no save dialog in a webview — report cancel
    return Promise.resolve(null)
  }

  /** slides:export-pdf */
  exportPdf(_op: ExportPdfOp): Promise<ExportPdfResult> {
    // printToPDF has no webview equivalent (docs/TAURI-MIGRATION.md §4)
    return Promise.resolve({
      ok: false,
      error: 'PDF export/print needs a Tauri-side implementation (TODO M4)',
    })
  }

  /** slides:print */
  printSlides(_op: PrintSlidesOp): Promise<{ ok: boolean; error?: string }> {
    // printToPDF/window.print orchestration needs a Tauri-side implementation
    return Promise.resolve({
      ok: false,
      error: 'PDF export/print needs a Tauri-side implementation (TODO M4)',
    })
  }

  // ── Recents / rename ─────────────────────────────────────────────────

  /** slides:recent */
  async getRecentFiles(): Promise<string[]> {
    return readRecent()
  }

  /** File renamed externally (shell Home list rename): swap the old path in the recent list for the new one (keeping its position). */
  replaceRecentFile(oldPath: string, newPath: string): void {
    try {
      // Do not use readRecent() filtering semantics here: the swap must see every stored path
      const raw = localStorage.getItem(RECENT_KEY)
      const cur: unknown = raw ? JSON.parse(raw) : []
      if (!Array.isArray(cur)) return
      localStorage.setItem(
        RECENT_KEY,
        JSON.stringify(cur.map((p) => (p === oldPath ? newPath : p))),
      )
    } catch {
      /* best-effort */
    }
  }

  /** Shell notification: the open file was renamed — sync the session path (subsequent
   *  saves write the new file) and notify via onRenamed so the bridge can update the title bar. */
  fileRenamed(oldPath: string, newPath: string): void {
    const session = this.session
    if (session && session.path === oldPath) session.path = newPath
    this.onRenamed?.(newPath)
  }
}

// Chromium refuses to even load video/quicktime, but demuxes QuickTime bytes
// fine through the ISO-BMFF path when served as video/mp4
const AV_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
}

export function createSlidesHost(): SlidesHost {
  return new SlidesHost()
}
