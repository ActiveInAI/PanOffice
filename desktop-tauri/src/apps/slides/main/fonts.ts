/**
 * System font metrics, ported from the Electron main process
 * (desktop/apps/slides/src/main/fonts.ts) into the webview: parse real font
 * files with opentype.js and inject them into pptx-render's OpentypeMetrics,
 * replacing heuristic estimation for accurate line wrapping/centering.
 *
 * Strategy (pragmatic), same as upstream:
 *   - Only an index of "normalized filename -> path" is built up front (no font
 *     parsing; ~ms cost);
 *   - Lazily parse and cache the matching file only when requested by (family, bold, italic);
 *   - .ttc collection fonts (nearly all CJK fonts) are unsupported by opentype.js; the name
 *     table picks a face by requested family, then the offset table splits a standalone sfnt;
 *   - Filename miss -> aliases/style-less variants -> substitute by script
 *     (ja/ko/traditional-zh/serif/mono) with fonts guaranteed on this platform -> if all miss,
 *     return undefined (callers use heuristic metrics).
 *
 * Port notes (byte access is the only structural change):
 *   - Under Tauri the font-file index comes from the Rust `list_fonts` command and
 *     font bytes are read through the bridge byte-store; both are async, so the
 *     host awaits `ensureSystemFontsReady(deckFamilies)` before the first layout
 *     (openPptx flow). resolve() itself stays sync over the warmed cache.
 *   - Under Node/vitest the same warmup installs a sync readFileSync reader, so
 *     resolve() keeps upstream's lazy read-through behavior.
 *   - In a plain browser there is no system font source: every lookup misses and
 *     the heuristic provider takes over (the upstream fallback path).
 *   - Buffer-based name-table/sfnt parsing is rewritten on Uint8Array + DataView.
 */
import * as opentype from 'opentype.js'
import {
  OpentypeMetrics,
  HeuristicMetrics,
  type FontMetricsProvider,
  type OpentypeFontLike,
  type RunStyle,
} from '@genoffice/pptx-render'
import { classifyCjkScript } from '../shared/cjk-script'
import { initShapedMetrics, shapedMeasure, shapedFamily } from './shaped-metrics'

/** 'darwin' | 'win32' | 'linux' — process.platform under Node/vitest, UA guess in the webview */
function hostPlatform(): string {
  if (typeof process !== 'undefined' && process.platform) return process.platform
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : ''
  if (ua.includes('mac')) return 'darwin'
  if (ua.includes('windows')) return 'win32'
  return 'linux'
}

function homeDir(): string {
  if (typeof process !== 'undefined' && process.env) {
    const home = process.env.HOME ?? process.env.USERPROFILE
    if (home) return home
  }
  return ''
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}

function fontDirs(): string[] {
  const home = homeDir()
  switch (hostPlatform()) {
    case 'darwin':
      return [
        '/System/Library/Fonts',
        '/System/Library/Fonts/Supplemental',
        '/Library/Fonts',
        ...(home ? [joinPath(home, 'Library/Fonts')] : []),
      ]
    case 'win32':
      return ['C:\\Windows\\Fonts', ...(home ? [home + '\\AppData\\Local\\Microsoft\\Windows\\Fonts'] : [])]
    default:
      return ['/usr/share/fonts', '/usr/local/share/fonts', ...(home ? [joinPath(home, '.fonts')] : [])]
  }
}

/** Normalize: NFKC (full-width MS -> MS), lowercase, strip spaces/hyphens/underscores. */
function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_]/g, '')
}

// Japanese fonts: Windows families/filenames and macOS Hiragino serve as each other's fallback
const YU_GOTHIC = ['YuGothM', 'YuGothB', 'YuGothR', 'YuGothic']
const YU_MINCHO = ['YuMin', 'YuMinDB', 'YuMincho']
const MEIRYO = ['Meiryo']
const MS_GOTHIC = ['MSGothic']
const MS_MINCHO = ['MSMincho']
// Base name first: combined with style suffixes (bold -> w6 / regular -> w3) to pick the file
// by weight; the full name with W3 is the fallback (index key = normalized filename)
const HIRAGINO_SANS = ['ヒラギノ角ゴシック', 'ヒラギノ角ゴシック W3']
const HIRAGINO_MINCHO = ['ヒラギノ明朝 ProN']

/** Common font-name aliases (localized name <-> English family <-> actual filename); keys match via norm. */
const ALIASES: Record<string, string[]> = {
  宋体: ['SimSun', 'Songti'],
  黑体: ['SimHei', 'Heiti SC'],
  微软雅黑: ['Microsoft YaHei', 'MSYH'],
  楷体: ['KaiTi', 'Kaiti SC'],
  仿宋: ['FangSong', 'STFangsong'],
  helvetica: ['Arial'],
  'helvetica neue': ['Arial'],
  calibri: ['Carlito', 'Arial'],
  // —— Japanese ——
  'yu gothic': [...YU_GOTHIC, ...HIRAGINO_SANS],
  游ゴシック: [...YU_GOTHIC, ...HIRAGINO_SANS],
  游ゴシック体: [...YU_GOTHIC, ...HIRAGINO_SANS],
  'yu mincho': [...YU_MINCHO, ...HIRAGINO_MINCHO],
  游明朝: [...YU_MINCHO, ...HIRAGINO_MINCHO],
  meiryo: [...MEIRYO, ...HIRAGINO_SANS],
  メイリオ: [...MEIRYO, ...HIRAGINO_SANS],
  'ms gothic': [...MS_GOTHIC, ...HIRAGINO_SANS],
  'ms pgothic': [...MS_GOTHIC, ...HIRAGINO_SANS],
  'ms ui gothic': [...MS_GOTHIC, ...HIRAGINO_SANS],
  'ms ゴシック': [...MS_GOTHIC, ...HIRAGINO_SANS],
  'ms pゴシック': [...MS_GOTHIC, ...HIRAGINO_SANS],
  'ms mincho': [...MS_MINCHO, ...HIRAGINO_MINCHO],
  'ms pmincho': [...MS_MINCHO, ...HIRAGINO_MINCHO],
  'ms 明朝': [...MS_MINCHO, ...HIRAGINO_MINCHO],
  'ms p明朝': [...MS_MINCHO, ...HIRAGINO_MINCHO],
  'hiragino sans': HIRAGINO_SANS,
  'hiragino kaku gothic pron': HIRAGINO_SANS,
  'hiragino kaku gothic pro': HIRAGINO_SANS,
  ヒラギノ角ゴシック: HIRAGINO_SANS,
  'hiragino mincho pron': HIRAGINO_MINCHO,
  'hiragino mincho pro': HIRAGINO_MINCHO,
  ヒラギノ明朝: HIRAGINO_MINCHO,
  // —— Korean ——
  'malgun gothic': ['Malgun', 'MalgunBD'],
  '맑은 고딕': ['Malgun Gothic', 'Malgun'],
  바탕: ['Batang'],
  바탕체: ['Batang'],
  batangche: ['Batang'],
  gungsuh: ['Batang'],
  궁서: ['Batang'],
  굴림: ['Gulim'],
  gulimche: ['Gulim'],
  dotum: ['Gulim'],
  돋움: ['Gulim'],
  // —— Traditional Chinese ——
  'microsoft jhenghei': ['MSJH'],
  微軟正黑體: ['Microsoft JhengHei', 'MSJH'],
  pmingliu: ['MingLiU'],
  新細明體: ['PMingLiU', 'MingLiU'],
  細明體: ['MingLiU'],
  'dfkai-sb': ['KaiU', 'BiauKai'],
  標楷體: ['DFKai-SB', 'KaiU', 'BiauKai'],
  'pingfang tc': ['PingFang'],
  'pingfang sc': ['PingFang'],
  'heiti tc': ['STHeiti Light', 'STHeiti Medium'],
  'heiti sc': ['STHeiti Light', 'STHeiti Medium'],
  'songti tc': ['Songti'],
  'songti sc': ['Songti'],
  宋體: ['Songti', 'PMingLiU', 'MingLiU'],
}
const ALIAS_MAP = new Map(Object.entries(ALIASES).map(([k, v]) => [norm(k), v]))
const aliasesOf = (family: string): string[] => ALIAS_MAP.get(norm(family)) ?? []

/**
 * Substitution for missing fonts (aligned with PowerPoint's font substitution): first classify
 * script by family name (ja/ko/traditional-zh) and substitute a same-script font guaranteed on
 * this platform; non-CJK substitutes by serif/mono/sans class. The key point is that the
 * substitution result is used for both measuring and drawing (displayFamily is passed through
 * to the renderer), so both sides always use the same font file — otherwise the width gap
 * between "heuristic estimate + browser-chosen fallback drawing" pushes later runs onto
 * earlier text.
 */
const SERIF_RE =
  /serif|roman|garamond|georgia|playfair|didot|bodoni|baskerville|caslon|palatino|antiqua|minion|lora|merriweather|crimson|spectral|charter|literata|song|songti|宋|mincho|明朝|ming|batang|바탕|myeongjo|명조|gungsuh|궁서|細明|標楷|儷宋/i
const MONO_RE = /mono|courier|consolas|menlo|monaco|code|typewriter/i

const SUBSTITUTES: Record<'serif' | 'sans' | 'mono', string[]> = {
  serif: ['Georgia', 'Times New Roman'],
  sans: ['Arial', 'Verdana'],
  mono: ['Courier New'],
}

function classifyFamily(family: string): 'serif' | 'sans' | 'mono' {
  if (MONO_RE.test(family)) return 'mono'
  if (SERIF_RE.test(family)) return 'serif'
  return 'sans'
}

function substitutesFor(family: string): string[] {
  const script = classifyCjkScript(family)
  if (!script) return SUBSTITUTES[classifyFamily(family)]
  const serif = SERIF_RE.test(family)
  const mac = hostPlatform() === 'darwin'
  switch (script) {
    case 'ja':
      return serif
        ? mac
          ? ['Hiragino Mincho ProN']
          : ['Yu Mincho', 'MS Mincho']
        : mac
          ? ['Hiragino Sans']
          : ['Yu Gothic', 'Meiryo', 'MS Gothic']
    case 'ko':
      return serif
        ? mac
          ? ['AppleMyungjo', 'Apple SD Gothic Neo']
          : ['Batang', 'Malgun Gothic']
        : mac
          ? ['Apple SD Gothic Neo', 'AppleGothic']
          : ['Malgun Gothic', 'Gulim']
    case 'tc':
      return serif
        ? mac
          ? ['Songti TC']
          : ['PMingLiU', 'Microsoft JhengHei']
        : mac
          ? ['PingFang TC', 'Heiti TC', 'Songti TC']
          : ['Microsoft JhengHei']
  }
}

/** Metadata for one face in a ttc/ttf (name table), used to pick a face by requested family/style. */
interface FaceInfo {
  /** Position of the offset table within the file (0 for non-ttc) */
  offset: number
  /** Family name for drawing: prefer the ASCII English name (resolvable by CSS by name) */
  display: string
  /** Normalized set of family names (name 1/16, including localized names) */
  famKeys: string[]
  /** Family + subfamily concatenation (normalized), used for style picks like bold/W6 */
  styleText: string
}

function readNameStrings(
  view: DataView,
  buf: Uint8Array,
  nameOff: number,
): { families: string[]; subfamilies: string[] } {
  const families: string[] = []
  const subfamilies: string[] = []
  const count = view.getUint16(nameOff + 2)
  const strBase = nameOff + view.getUint16(nameOff + 4)
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + 12 * i
    const platform = view.getUint16(r)
    const encoding = view.getUint16(r + 2)
    const nameId = view.getUint16(r + 6)
    if (nameId !== 1 && nameId !== 2 && nameId !== 16 && nameId !== 17) continue
    const len = view.getUint16(r + 8)
    const off = strBase + view.getUint16(r + 10)
    if (off + len > buf.length) continue
    let s: string
    if (platform === 0 || platform === 3) {
      // UTF-16BE
      const u16 = new Uint16Array(len / 2)
      for (let c = 0; c < u16.length; c++) u16[c] = view.getUint16(off + c * 2)
      s = String.fromCharCode(...u16)
    } else if (platform === 1 && encoding === 0) {
      s = Array.from(buf.subarray(off, off + len))
        .map((b) => String.fromCharCode(b))
        .join('')
    } else {
      continue // Mac-platform non-Roman encodings (legacy Korean/Chinese codepages) cannot be decoded; skip
    }
    if (!s) continue
    const list = nameId === 1 || nameId === 16 ? families : subfamilies
    if (!list.includes(s)) list.push(s)
  }
  return { families, subfamilies }
}

function asciiOf(buf: Uint8Array, start: number, end: number): string {
  let s = ''
  for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]!)
  return s
}

function readFaceDir(buf: Uint8Array): FaceInfo[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const offsets =
    asciiOf(buf, 0, 4) === 'ttcf'
      ? Array.from({ length: view.getUint32(8) }, (_, i) => view.getUint32(12 + 4 * i))
      : [0]
  return offsets.map((offset) => {
    let families: string[] = []
    let subfamilies: string[] = []
    try {
      const numTables = view.getUint16(offset + 4)
      for (let t = 0; t < numTables; t++) {
        const e = offset + 12 + 16 * t
        if (asciiOf(buf, e, e + 4) === 'name') {
          ;({ families, subfamilies } = readNameStrings(view, buf, view.getUint32(e + 8)))
          break
        }
      }
    } catch {
      /* Even if the name table is unreadable, the first face can still be parsed */
    }
    const ascii = families.find((f) => /^[\x20-\x7e]+$/.test(f))
    return {
      offset,
      display: ascii ?? families[0] ?? '',
      famKeys: families.map(norm),
      styleText: norm([...families, ...subfamilies].join(' ')),
    }
  })
}

/** Extract a single face from a ttc into a standalone sfnt (rewrite the table directory, copy table data by original offset). */
function extractFace(buf: Uint8Array, offset: number): ArrayBuffer {
  if (asciiOf(buf, 0, 4) !== 'ttcf') {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const numTables = view.getUint16(offset + 4)
  let total = 12 + 16 * numTables
  const entries: Array<{ dirPos: number; tOff: number; tLen: number; newOff: number }> = []
  for (let t = 0; t < numTables; t++) {
    const e = offset + 12 + 16 * t
    const tLen = view.getUint32(e + 12)
    entries.push({ dirPos: e, tOff: view.getUint32(e + 8), tLen, newOff: total })
    total += (tLen + 3) & ~3
  }
  const out = new Uint8Array(total)
  const outView = new DataView(out.buffer)
  out.set(buf.subarray(offset, offset + 12), 0)
  for (let t = 0; t < numTables; t++) {
    const e = entries[t]!
    out.set(buf.subarray(e.dirPos, e.dirPos + 8), 12 + 16 * t)
    outView.setUint32(12 + 16 * t + 8, e.newOff)
    outView.setUint32(12 + 16 * t + 12, e.tLen)
    out.set(buf.subarray(e.tOff, e.tOff + e.tLen), e.newOff)
  }
  return out.buffer
}

function rankFaces(faces: FaceInfo[], wantKey: string, style: RunStyle): FaceInfo[] {
  const styleKeys =
    style.bold && style.italic
      ? ['bolditalic']
      : style.bold
        ? ['bold', 'w6']
        : style.italic
          ? ['italic', 'oblique']
          : ['regular', 'w3', 'medium']
  const score = (f: FaceInfo) =>
    (f.display.startsWith('.') ? -4 : 0) +
    (f.famKeys.some((k) => k === wantKey || k.startsWith(wantKey)) ? 2 : 0) +
    (styleKeys.some((s) => f.styleText.includes(s)) ? 1 : 0)
  return [...faces].sort((a, b) => score(b) - score(a))
}

// ---- environment byte access ----

/** Sync font-file reader, installed by ensureSystemFontsReady under Node/vitest (readFileSync). */
let syncReadFile: ((path: string) => Uint8Array) | null = null

/** Async font-file reader under Tauri (bridge byte-store over the Rust read_file command). */
let asyncReadFile: ((path: string) => Promise<Uint8Array>) | null = null

/** True inside the Tauri webview (kept local so this module never imports the bridge). */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** One font file as listed by the host scan (Rust list_fonts) or the Node fs scan. */
interface FontFileEntry {
  path: string
  /** file basename, e.g. 'YuGothM.ttc' */
  name: string
}

/** Recursive scan for font files under dir (Node mode only; failures yield []). */
async function scanFontDirNode(
  fs: typeof import('node:fs'),
  dir: string,
  depth: number,
  out: FontFileEntry[],
): Promise<void> {
  if (depth > 4 || out.length > 20_000) return
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const full = joinPath(dir, name)
    let isFile = false
    let isDir = false
    try {
      const st = fs.statSync(full)
      isFile = st.isFile()
      isDir = st.isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      await scanFontDirNode(fs, full, depth + 1, out)
    } else if (isFile && /\.(ttf|otf|ttc|otc)$/i.test(name)) {
      out.push({ path: full, name })
    }
  }
}

/**
 * List system font files for the current environment:
 * Tauri → the Rust `list_fonts` command; Node/vitest → fs scan of the platform
 * font dirs; plain browser → none (heuristic metrics take over).
 */
async function listSystemFontFiles(): Promise<FontFileEntry[]> {
  if (inTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<Array<{ path: string; name: string }>>('list_fonts')
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }
  if (typeof process !== 'undefined' && process.versions?.node) {
    try {
      const fs = await import('node:fs')
      const out: FontFileEntry[] = []
      for (const dir of fontDirs()) await scanFontDirNode(fs, dir, 0, out)
      return out
    } catch {
      return []
    }
  }
  return []
}

class FontRegistry {
  /** Normalized file basename (no extension) -> absolute path */
  private index = new Map<string, string>()
  /** Path -> face directory */
  private faceDirs = new Map<string, FaceInfo[]>()
  /** `path#offset` -> parsed font (null = parse failed) */
  private parsed = new Map<string, OpentypeFontLike | null>()
  /** Path -> file bytes (Tauri/browser mode: pre-warmed; Node mode: read through) */
  private bytes = new Map<string, Uint8Array | null>()
  private indexed = false

  /** Install the scanned index (idempotent). */
  buildIndex(files: FontFileEntry[]): void {
    if (this.indexed) return
    this.indexed = true
    for (const { path, name } of files) {
      const m = /^(.+)\.(ttf|otf|ttc|otc)$/i.exec(name)
      if (!m) continue
      // Strip the variable-font axis suffix: NotoSansSC[wght].ttf -> notosanssc
      const key = norm(m[1]!.replace(/\[[^\]]*\]$/, ''))
      if (!this.index.has(key)) this.index.set(key, path)
    }
  }

  /** Pre-warm file bytes (Tauri mode) so the sync resolve path can parse them. */
  warmBytes(path: string, data: Uint8Array): void {
    this.bytes.set(path, data)
  }

  /** Every index path resolve() might try for a family (style variants + regular fallback). */
  candidatePaths(family: string): string[] {
    const base = norm(family)
    const suffixes = ['', 'regular', 'w4', 'w3', 'bold', 'bd', 'b', 'w7', 'w6', 'bolditalic', 'bi', 'bold italic', 'italic', 'it', 'i', 'oblique']
    const out: string[] = []
    for (const suf of suffixes) {
      const path = this.index.get(base + norm(suf))
      if (path && !out.includes(path)) out.push(path)
    }
    return out
  }

  /** All candidate families resolve() would try for a requested family (itself + aliases + script substitutes). */
  candidateFamilies(family: string): string[] {
    const candidates: string[] = []
    const seen = new Set<string>()
    const push = (f: string) => {
      const k = norm(f)
      if (k && !seen.has(k)) {
        seen.add(k)
        candidates.push(f)
      }
    }
    push(family)
    for (const a of aliasesOf(family)) push(a)
    for (const s of substitutesFor(family)) {
      push(s)
      for (const a of aliasesOf(s)) push(a)
    }
    return candidates
  }

  private bytesOf(path: string): Uint8Array | null {
    const cached = this.bytes.get(path)
    if (cached !== undefined) return cached
    let data: Uint8Array | null = null
    if (syncReadFile) {
      try {
        data = syncReadFile(path)
      } catch {
        data = null
      }
    }
    this.bytes.set(path, data)
    return data
  }

  private facesOf(path: string): FaceInfo[] {
    const cached = this.faceDirs.get(path)
    if (cached) return cached
    let faces: FaceInfo[] = []
    const data = this.bytesOf(path)
    if (data) {
      try {
        faces = readFaceDir(data)
      } catch {
        faces = []
      }
    }
    this.faceDirs.set(path, faces)
    return faces
  }

  private parseFace(path: string, offset: number): OpentypeFontLike | null {
    const key = `${path}#${offset}`
    const cached = this.parsed.get(key)
    if (cached !== undefined) return cached
    let font: OpentypeFontLike | null = null
    const data = this.bytesOf(path)
    if (data) {
      try {
        font = opentype.parse(extractFace(data, offset)) as unknown as OpentypeFontLike
      } catch {
        font = null
      }
    }
    this.parsed.set(key, font)
    return font
  }

  private loadBest(
    path: string,
    wantKey: string,
    style: RunStyle,
  ): { font: OpentypeFontLike; family: string } | undefined {
    for (const face of rankFaces(this.facesOf(path), wantKey, style)) {
      const font = this.parseFace(path, face.offset)
      if (font) return { font, family: face.display }
    }
    return undefined
  }

  /**
   * Find a font by family + bold/italic; candidates in order: requested family -> aliases ->
   * script substitution (each with its own aliases). At the file level, try style variants then
   * fall back to regular; within a ttc, pick a face by the name table. Returns the matched font
   * and its "drawing family name" (the face's English family, guaranteed CSS-resolvable).
   */
  resolve(style: RunStyle): { font: OpentypeFontLike; family: string } | undefined {
    const candidates = this.candidateFamilies(style.fontFamily)
    // wN: Japanese fonts split files by weight (Hiragino Kaku Gothic W0..W9), and Chromium
    // matches faces by CSS weight (bold=700 -> W7, normal=400 -> W4) — metrics must pick the
    // same-weight file, or the "measure W3, draw W7" width gap makes later runs overlap text
    // (measured ~15% off on Salesforce)
    const suffixes =
      style.bold && style.italic
        ? ['bolditalic', 'bi', 'bold italic', 'w7', 'w6']
        : style.bold
          ? ['bold', 'bd', 'b', 'w7', 'w6']
          : style.italic
            ? ['italic', 'it', 'i', 'oblique']
            : ['', 'regular', 'w4', 'w3']
    for (const family of candidates) {
      const base = norm(family)
      // Try style-variant files first, then fall back to regular (approximate widths still far better than heuristics)
      for (const suf of [...suffixes, '', 'regular']) {
        const path = this.index.get(base + norm(suf))
        if (!path) continue
        const hit = this.loadBest(path, base, style)
        if (hit) return { font: hit.font, family: hit.family || family }
      }
    }
    return undefined
  }
}

/** The process-wide registry (one index/warm cycle per session). */
const registry = new FontRegistry()
let fontsReadyPromise: Promise<void> | null = null

/**
 * Build the system-font index and warm the parse cache for the given families
 * (a deck's run fonts). Await before the first layout — the metrics provider's
 * sync resolve() only serves the warmed cache (plus sync read-through under
 * Node/vitest). Plain-browser mode resolves immediately to "no fonts" and every
 * lookup falls back to heuristic metrics, matching upstream's missing-font path.
 */
export function ensureSystemFontsReady(families?: string[]): Promise<void> {
  fontsReadyPromise ??= (async () => {
    try {
      // Node/vitest: install the sync read-through reader first (resolve stays lazy)
      if (typeof process !== 'undefined' && process.versions?.node) {
        try {
          const fs = await import('node:fs')
          syncReadFile = (path) => new Uint8Array(fs.readFileSync(path))
        } catch {
          /* no fs — read-through disabled */
        }
      } else if (inTauri()) {
        asyncReadFile = async (path) => {
          const { platform } = await import('../../../bridge/platform')
          return platform.readFile(path)
        }
      }
      const files = await listSystemFontFiles()
      registry.buildIndex(files)
      // Tauri/browser mode: pre-warm bytes for every candidate path of the deck's families
      if (asyncReadFile && families) {
        const paths = new Set<string>()
        for (const family of families) {
          for (const candidate of registry.candidateFamilies(family)) {
            for (const path of registry.candidatePaths(candidate)) paths.add(path)
          }
        }
        const reader = asyncReadFile
        await Promise.all(
          [...paths].map(async (path) => {
            try {
              registry.warmBytes(path, await reader(path))
            } catch {
              /* missing file: resolve() will miss and fall back */
            }
          }),
        )
      }
    } catch {
      /* font metrics are best-effort; heuristics take over */
    }
  })()
  return fontsReadyPromise
}

/** One glyph as returned by opentype.js (only the advance is read here). */
interface OpentypeGlyph {
  advanceWidth?: number
}

/**
 * Structural view of the opentype.js runtime internals probed below (glyph lookup,
 * kern pairs, variable-font fvar/HVAR tables). Everything is feature-detected at
 * runtime; the cast just names the shape instead of erasing it with `any`.
 */
interface OpentypeRuntimeFont extends OpentypeFontLike {
  charToGlyph?(char: string): OpentypeGlyph
  getKerningValue?(left: unknown, right: unknown): number
  tables?: {
    fvar?: {
      axes?: Array<{ tag: string; minValue: number; maxValue: number; defaultValue: number }>
    }
    hvar?: unknown
  }
  variation?: {
    getTransform?(
      glyph: OpentypeGlyph,
      coords: Record<string, number>,
    ): { advanceWidth?: number } | undefined
  }
}

/**
 * Bypass opentype.js's getAdvanceWidth: it runs Bidi/GSUB text shaping and throws on
 * unsupported lookups (e.g. Inter's ccmp lookupType6/substFormat2); the caller catches and the
 * whole run falls back to heuristics — uppercase Latin gets underestimated ~18%, inter-word
 * spaces get swallowed, and runs can even overlap. Here we accumulate advance per glyph (with
 * kern pairs) without triggering the shaping path.
 */
function wrapSafeAdvance(font: OpentypeFontLike): OpentypeFontLike {
  const f = font as OpentypeRuntimeFont
  if (typeof f.charToGlyph !== 'function') return font
  return {
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascender,
    descender: font.descender,
    ...(font.charToGlyphIndex
      ? { charToGlyphIndex: (ch: string) => font.charToGlyphIndex!(ch) }
      : {}),
    getAdvanceWidth(text: string, fontSize: number): number {
      let units = 0
      let prev: unknown = null
      for (const ch of text) {
        const glyph = f.charToGlyph!(ch)
        units += glyph?.advanceWidth ?? 0
        if (prev && typeof f.getKerningValue === 'function') {
          try {
            units += f.getKerningValue(prev, glyph) || 0
          } catch {
            /* Treat a failed kern lookup as 0 */
          }
        }
        prev = glyph
      }
      return (units / font.unitsPerEm) * fontSize
    },
  }
}

/**
 * Instantiate advances of variable fonts at the requested weight (opentype.js 2.x variation
 * API + HVAR).
 *
 * Background: Google Fonts variable fonts (e.g. NotoSansJP[wght].ttf) may default to
 * Thin (wght=100), and opentype's getAdvanceWidth only measures the default instance; Chromium
 * actually renders at 400/700, where digits/Latin can be ~16% wider, causing mixed-script run
 * overlap (e.g. a CJK unit suffix after "3,173" pressed onto the digits). For fonts with a
 * wght axis, apply HVAR deltas per glyph and recompute advances at bold?700:400 (no kern;
 * negligible for CJK/digit scenarios).
 */
function instantiateWeight(font: OpentypeFontLike, bold: boolean): OpentypeFontLike {
  const f = font as OpentypeRuntimeFont
  const wghtAxis = f.tables?.fvar?.axes?.find((a) => a.tag === 'wght')
  if (
    !wghtAxis ||
    typeof f.variation?.getTransform !== 'function' ||
    !f.tables?.hvar ||
    typeof f.charToGlyph !== 'function' ||
    typeof f.charToGlyphIndex !== 'function'
  ) {
    return font
  }
  const target = Math.min(Math.max(bold ? 700 : 400, wghtAxis.minValue), wghtAxis.maxValue)
  if (target === wghtAxis.defaultValue) return font
  const coords = { wght: target }
  /** glyph index -> advance (font units, already instantiated) */
  const advCache = new Map<number, number>()
  return {
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascender,
    descender: font.descender,
    ...(font.charToGlyphIndex
      ? { charToGlyphIndex: (ch: string) => font.charToGlyphIndex!(ch) }
      : {}),
    getAdvanceWidth(text: string, fontSize: number): number {
      let units = 0
      for (const ch of text) {
        const gid = f.charToGlyphIndex!(ch)
        let adv = advCache.get(gid)
        if (adv == null) {
          const glyph = f.charToGlyph!(ch)
          try {
            adv = f.variation!.getTransform!(glyph, coords)?.advanceWidth ?? glyph.advanceWidth ?? 0
          } catch {
            adv = glyph.advanceWidth ?? 0
          }
          advCache.set(gid, adv)
        }
        units += adv
      }
      return (units / font.unitsPerEm) * fontSize
    },
  }
}

/** Create a metrics provider injected with system fonts (falls back to heuristics per run when no font is found). */
export function createSystemFontMetrics(): FontMetricsProvider {
  initShapedMetrics()
  const cache = new Map<string, { font: OpentypeFontLike; family: string } | undefined>()
  const resolveEntry = (style: RunStyle) => {
    const key = `${style.fontFamily}|${style.bold ? 1 : 0}${style.italic ? 1 : 0}`
    if (cache.has(key)) return cache.get(key)
    const raw = registry.resolve(style)
    let entry: { font: OpentypeFontLike; family: string } | undefined
    if (raw) {
      const inst = instantiateWeight(raw.font, style.bold)
      // Non-variable fonts (instantiateWeight returned as-is) need the safe-advance wrapper;
      // the variable-font path already accumulates per glyph and is inherently safe
      entry = { font: inst === raw.font ? wrapSafeAdvance(raw.font) : inst, family: raw.family }
    }
    cache.set(key, entry)
    return entry
  }
  const inner = new OpentypeMetrics((style) => resolveEntry(style)?.font, new HeuristicMetrics())
  return {
    metrics: (style) => inner.metrics(style),
    // Complex scripts (ligatures/contextual forms) prefer HarfBuzz shaped metrics — opentype's
    // per-glyph accumulation measures isolated forms, drifting from actual drawing; falls back
    // to the original path when not ready or no font
    measure: (text, style) =>
      shapedMeasure(text, style.fontSizePx, style.bold, style.italic) ?? inner.measure(text, style),
    // Substituted fonts return the substitute family; the renderer draws with it (same font file for measuring/drawing)
    displayFamily: (style, text) =>
      (text != null ? shapedFamily(text) : null) ?? resolveEntry(style)?.family ?? style.fontFamily,
  }
}
