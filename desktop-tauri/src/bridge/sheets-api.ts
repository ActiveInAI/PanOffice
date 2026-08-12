/**
 * window.desktopApi + window.projectApi — the sheets editor's host surface,
 * ported from the Electron preload + main handlers
 * (desktop/apps/sheets/src/{preload,main}) onto the Tauri shell.
 *
 * What runs where after the port:
 *  - the preload's validation layer: src/bridge/sheets-validate.ts (verbatim),
 *  - the main-process session/save logic (sheets-main.ts): this file, in the
 *    webview, driving the sidecar through src/bridge/xlsx-rpc.ts (Tauri
 *    command in the app, HTTP dev server in the browser),
 *  - the gateway save pipeline (xlsx-package-io / xlsx-gateway): unchanged in
 *    the webview, with fs access via the HostIo abstraction,
 *  - AI: the shared in-webview bridge (./ai-stream.ts),
 *  - gsk login/web+image search, native dialogs/menus, the close guard and
 *    PDF export: honest stubs, same policy as the docs port (TODO M3).
 *
 * Path model: the renderer works on *logical* paths (what platform.ts reads
 * and writes); the sidecar works on *host* paths (real files). host.stage
 * bridges the two — a passthrough for real files (Tauri), a temp copy for
 * URL-ish paths (browser dev). Saves run the sidecar pipeline on the host
 * path, then the bytes land in the logical store (IndexedDB overlay in the
 * browser, real disk under Tauri) — the same overlay pattern as docs/pdf.
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
  MenuAction,
  WorkbookFile,
  WorkbookSaveRequest,
  WorkbookSaveResult,
} from '../apps/sheets/shared/desktop-api'
import {
  ATTACHMENT_IMAGE_EXTS,
  workbookPivotDefinitionSchema,
} from '../apps/sheets/shared/desktop-api'
import { csvToXlsxBuffer, decodeCsvBuffer } from '../apps/sheets/gateway/csv-import'
import { dirName, joinPath } from '../apps/sheets/gateway/host-io'
import { sha256Hex } from '../apps/sheets/gateway/sha256'
import type { CellEdit, SheetStructuralOps } from '../apps/sheets/gateway/xlsx-gateway'
import {
  readArchiveEntryText,
  saveWorkbookViaSidecar,
} from '../apps/sheets/gateway/xlsx-package-io'
import { parsePivotDefinition } from '../apps/sheets/gateway/xlsx-pivot'
import type { SheetEditPlan } from '../apps/sheets/gateway/xlsx-sheets'
import { createAiBridge } from './ai-stream'
import { isTauri, platform } from './platform'
import {
  isPdfPageSize,
  isRecord,
  isUuid,
  parseAttachmentAddResult,
  parseFormulaCellsRequest,
  parseFormulaCellsResult,
  parseMediaRequest,
  parseMediaResult,
  parsePivotDefinitionResult,
  parsePivotRequest,
  parseRangeRequest,
  parseRangeResult,
  parseRecalcRequest,
  parseRecalcResult,
  parseSaveRequest,
  parseSaveResult,
  parseWorkbookFile,
} from './sheets-validate'
import {
  createRpcArchiveClient,
  createRpcHostIo,
  readHostFile,
  stageForSidecar,
  xlsxClient,
} from './xlsx-rpc'

const LANG_KEY = 'panoffice.lang'
/** Overlay key prefix for crash-recovery copies (never shadows the real path) */
const RECOVERY_PREFIX = '__sheets_recovery__/'
/** Same caps as the upstream attachment handlers (sheets-main.ts) */
const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** Overlay key prefix for attachment bytes picked/pasted in-session */
const ATTACHMENT_DIR = 'sheets-attachments'
/** Local images inserted by AI tools are capped upstream at 20MB */
const LOCAL_IMAGE_MAX_BYTES = 20 * 1024 * 1024

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** plain-text extensions read as UTF-8 (same list as upstream sheets-main.ts) */
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

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path

const extOf = (name: string): string => name.split('.').pop()?.toLowerCase() ?? ''

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// ---- workbook sessions (the sheets-main SessionInfo map) ----

interface SessionInfo {
  /** path the renderer/platform store sees (overlay key or real path) */
  readonly logicalPath: string
  /** real file the sidecar has open (staging copy for URL-ish sources) */
  readonly hostPath: string
  /** hostPath is a staged copy: saves must sync bytes back to the store */
  readonly staged: boolean
  readonly sha256: string
  readonly sheetNames: ReadonlyMap<string, string>
  /// Converted import (.xls/.csv): the first save routes through Save As.
  readonly suggestSaveAs?: string
  readonly csvImport?: boolean
}

const sessions = new Map<string, SessionInfo>()
const archiveClient = createRpcArchiveClient()
const hostIo = createRpcHostIo()

/** sha256 of the logical bytes — detects drift between open and save */
async function hashLogical(logicalPath: string): Promise<string> {
  return sha256Hex(await platform.readFile(logicalPath))
}

// ---- pending open path (#/sheets?src=…) ----

let pendingConsumed = false

/** Prepare the single-use route source before the shell mounts a new Sheets view. */
export function resetPendingWorkbookSource(): void {
  pendingConsumed = false
}

/** Take the workbook path queued for this view (the shell routes `#/sheets?src=…`); null afterwards */
function consumePendingSrc(): string | null {
  if (pendingConsumed) return null
  pendingConsumed = true
  const query = window.location.hash.split('?')[1] ?? ''
  return new URLSearchParams(query).get('src')
}

/** which legacy charset an Excel CSV most likely uses, judged by the UI language */
function legacyCsvCharset(lang: string): string | undefined {
  const byLang: Record<string, string> = {
    zh: 'gb18030',
    ja: 'shift_jis',
    ko: 'euc-kr',
  }
  return byLang[lang]
}

/**
 * Open one logical path as a workbook session: read the bytes, stage them for
 * the sidecar (converting .csv/.xls imports first), open, and register the
 * session. Mirrors sheets-main's prepareWorkbookForOpen + openWorkbookSession.
 */
async function openWorkbookPath(logicalPath: string): Promise<WorkbookFile> {
  const extension = extOf(logicalPath)
  let hostPath: string
  let staged: boolean
  let suggestSaveAs: string | undefined
  let csvImport: boolean | undefined
  // TODO(M3): crash-recovery restore prompt — upstream compares the recovery
  // copy's mtime against the original and offers Restore/Discard; the overlay
  // tracks no mtimes and the dialog is native (same gap as the docs port).
  if (extension === 'csv' || extension === 'xls') {
    const lang = await getLanguage()
    let converted: Uint8Array
    if (extension === 'csv') {
      converted = await csvToXlsxBuffer(
        decodeCsvBuffer(await platform.readFile(logicalPath), legacyCsvCharset(lang)),
      )
      csvImport = true
    } else {
      const sourceHost = await stageForSidecar(
        logicalPath,
        await platform.readFile(logicalPath),
      )
      const workDir = await hostIo.mkdtemp('panoffice-xlsx-import-')
      hostPath = joinPath(workDir, `${basename(logicalPath).replace(/\.[^.]+$/, '')}.xlsx`)
      await xlsxClient.convertWorkbook({ path: sourceHost, targetPath: hostPath })
      converted = await readHostFile(hostPath)
    }
    if (extension === 'csv') {
      hostPath = await stageForSidecar(`${logicalPath}.import.xlsx`, converted)
    }
    staged = true
    suggestSaveAs = logicalPath.replace(/\.[^.]+$/, '.xlsx')
    const digest = sha256Hex(converted)
    return openStagedWorkbook(hostPath!, staged, logicalPath, digest, suggestSaveAs, csvImport)
  }
  const bytes = await platform.readFile(logicalPath)
  hostPath = await stageForSidecar(logicalPath, bytes)
  staged = hostPath !== logicalPath
  return openStagedWorkbook(hostPath, staged, logicalPath, sha256Hex(bytes), undefined, undefined)
}

async function openStagedWorkbook(
  hostPath: string,
  staged: boolean,
  logicalPath: string,
  digest: string,
  suggestSaveAs: string | undefined,
  csvImport: boolean | undefined,
): Promise<WorkbookFile> {
  const opened = (await xlsxClient.open(hostPath)) as Record<string, unknown>
  sessions.set(opened.sessionId as string, {
    logicalPath,
    hostPath,
    staged,
    sha256: digest,
    sheetNames: new Map(
      (opened.sheets as { id: string; name: string }[]).map((sheet) => [sheet.id, sheet.name]),
    ),
    ...(suggestSaveAs === undefined ? {} : { suggestSaveAs }),
    ...(csvImport ? { csvImport } : {}),
  })
  // The sidecar names the workbook after the host file; the renderer shows the
  // logical name (a staged temp name would leak otherwise).
  return parseWorkbookFile({
    ...opened,
    name: basename(logicalPath),
    path: logicalPath,
    sha256: digest,
    readOnly: false,
    needsSaveAs: suggestSaveAs !== undefined,
  })
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

async function selectWorkbook(): Promise<WorkbookFile | null> {
  const pending = consumePendingSrc()
  if (pending) {
    return openWorkbookPath(pending)
  }
  // TODO(M3): native open dialog (tauri plugin-dialog) returning a real path
  const files = await pickFile('.xlsx,.xls,.csv')
  const file = files?.[0]
  if (!file) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Picked files have no local path in a webview; park the bytes in the
  // overlay under the file name so the workbook is reopenable in-session.
  await platform.writeFile(file.name, bytes)
  return openWorkbookPath(file.name)
}

// ---- range / formulas / recalc / media / pivot ----

function sessionFor(sessionId: string): SessionInfo {
  const session = sessions.get(sessionId)
  if (!session) throw new Error('Unknown workbook session.')
  return session
}

async function readWorkbookRange(request: unknown) {
  const validated = parseRangeRequest(request as never)
  sessionFor(validated.sessionId)
  return parseRangeResult(await xlsxClient.readRange(validated))
}

async function readWorkbookFormulas(request: unknown) {
  const validated = parseFormulaCellsRequest(request)
  sessionFor(validated.sessionId)
  return parseFormulaCellsResult(await xlsxClient.readFormulaCells(validated))
}

/** IronCalc recalculation; sheet ids resolve through the session's file sheet names. */
async function recalcWorkbook(request: unknown) {
  const validated = parseRecalcRequest(request)
  const session = sessionFor(validated.sessionId)
  const fileSheetName = (sheetId: string): string => {
    const name = session.sheetNames.get(sheetId)
    if (name === undefined) throw new Error(`Unknown sheet for recalculation: ${sheetId}`)
    return name
  }
  const result = (await xlsxClient.recalcCells({
    path: session.hostPath,
    edits: validated.edits.map((edit) => ({
      sheet: fileSheetName(edit.sheetId),
      row: edit.row,
      column: edit.column,
      input: edit.input,
    })),
    reads: validated.reads.map((read) => ({
      sheet: fileSheetName(read.sheetId),
      range: read.range,
    })),
  })) as {
    cells: {
      sheet: string
      row: number
      column: number
      formatted: string
      number?: number
      isFormula: boolean
    }[]
  }
  const idsByName = new Map([...session.sheetNames].map(([id, name]) => [name, id]))
  return parseRecalcResult({
    cells: result.cells.flatMap((cell) => {
      const sheetId = idsByName.get(cell.sheet)
      if (sheetId === undefined) return []
      return [
        {
          sheetId,
          row: cell.row,
          column: cell.column,
          formatted: cell.formatted,
          ...(cell.number === undefined ? {} : { number: cell.number }),
          isFormula: cell.isFormula,
        },
      ]
    }),
  })
}

async function readWorkbookMedia(request: unknown) {
  const validated = parseMediaRequest(request as never)
  sessionFor(validated.sessionId)
  return parseMediaResult(await xlsxClient.readMedia(validated))
}

async function readPivotDefinition(request: unknown) {
  const validated = parsePivotRequest(request as never)
  const session = sessionFor(validated.sessionId)
  const [pivotXml, cacheXml] = await Promise.all([
    readArchiveEntryText(archiveClient, session.hostPath, validated.path, hostIo),
    readArchiveEntryText(archiveClient, session.hostPath, validated.cachePath, hostIo),
  ])
  return workbookPivotDefinitionSchema.parse(parsePivotDefinition(pivotXml, cacheXml))
}

// ---- save (the sheets-main writeWorkbookTo pipeline, in the webview) ----

/**
 * Resolve a save request's sheet ops / name mappings and write the workbook
 * through the sidecar. Ported 1:1 from sheets-main.ts so the recovery writer
 * can reuse the exact same pipeline with a different targetPath.
 */
async function writeWorkbookTo(
  session: SessionInfo,
  request: WorkbookSaveRequest,
  targetPath: string,
) {
  // Sheet ops resolve first: added sheets have Univer ids the session map
  // doesn't know, so cell edits into them resolve through the op's name.
  const addedSheetNames = new Map<string, string>()
  // Added sheet id → file name of the sheet whose part seeds the new part.
  const duplicateSources = new Map<string, string>()
  const renames: { sheetName: string; newName: string }[] = []
  const removals: string[] = []
  const hiddenChanges: { sheetName: string; hidden: boolean }[] = []
  let orderChanged = false
  for (const op of request.sheetOps) {
    if (op.kind === 'add-sheet') {
      addedSheetNames.set(op.sheetId, op.name)
      continue
    }
    if (op.kind === 'duplicate-sheet') {
      // The renderer resolves duplicate chains to a sheet the file knows,
      // so the source must be in the session map.
      const sourceName = session.sheetNames.get(op.sourceSheetId)
      if (!sourceName) throw new Error(`Unknown duplicate source ${op.sourceSheetId}.`)
      addedSheetNames.set(op.sheetId, op.name)
      duplicateSources.set(op.sheetId, sourceName)
      continue
    }
    if (op.kind === 'reorder-sheets') {
      orderChanged = true
      continue
    }
    const sheetName = addedSheetNames.get(op.sheetId) ?? session.sheetNames.get(op.sheetId)
    if (!sheetName) throw new Error(`Unknown worksheet ${op.sheetId}.`)
    if (op.kind === 'rename-sheet') renames.push({ sheetName, newName: op.newName })
    else if (op.kind === 'set-sheet-hidden') {
      hiddenChanges.push({ sheetName, hidden: op.hidden })
    } else removals.push(sheetName)
  }
  const renameByOriginal = new Map(renames.map((rename) => [rename.sheetName, rename.newName]))
  const resolveSheetName = (sheetId: string): string => {
    const sheetName = addedSheetNames.get(sheetId) ?? session.sheetNames.get(sheetId)
    if (!sheetName) throw new Error(`Unknown worksheet ${sheetId}.`)
    return sheetName
  }
  let sheetPlan: SheetEditPlan | undefined
  if (request.sheetOps.length > 0) {
    sheetPlan = {
      renames,
      additions: [...addedSheetNames].map(([sheetId, name]) => ({
        name,
        sourceSheetName: duplicateSources.get(sheetId),
      })),
      removals,
      hiddenChanges,
      orderChanged,
      order: request.sheetOrder.map((sheetId) => {
        const original = resolveSheetName(sheetId)
        return addedSheetNames.has(sheetId)
          ? original
          : (renameByOriginal.get(original) ?? original)
      }),
    }
  }

  const edits: CellEdit[] = request.edits.map((edit) => ({
    sheetName: resolveSheetName(edit.sheetId),
    row: edit.row,
    column: edit.column,
    writeValue: edit.writeValue,
    cell: { value: edit.value, formula: edit.formula },
    style: edit.style,
    rich: edit.rich,
    styleReset: edit.styleReset,
  }))
  const opsBySheet = new Map<string, SheetStructuralOps['ops'][number][]>()
  for (const op of request.structuralOps) {
    const sheetName = resolveSheetName(op.sheetId)
    const sheetOps = opsBySheet.get(sheetName) ?? []
    if ('range' in op) {
      sheetOps.push({ kind: op.kind, range: op.range })
    } else if ('size' in op) {
      sheetOps.push({ kind: op.kind, start: op.start, end: op.end, size: op.size })
    } else if ('level' in op) {
      sheetOps.push({
        kind: op.kind,
        start: op.start,
        end: op.end,
        level: op.level,
        ...(op.collapsed === undefined ? {} : { collapsed: op.collapsed }),
      })
    } else if ('hidden' in op) {
      sheetOps.push({ kind: op.kind, start: op.start, end: op.end, hidden: op.hidden })
    } else {
      sheetOps.push({ kind: op.kind, index: op.index, count: op.count })
    }
    opsBySheet.set(sheetName, sheetOps)
  }
  const structuralOps: SheetStructuralOps[] = [...opsBySheet].map(([sheetName, ops]) => ({
    sheetName,
    ops,
  }))
  const filterStates = request.filterStates.map((state) => ({
    sheetName: resolveSheetName(state.sheetId),
    filter: state.filter,
    hiddenRows: state.hiddenRows,
    visibilityRange: state.visibilityRange,
  }))
  const linksBySheet = new Map<string, { row: number; column: number; target: string | null }[]>()
  for (const link of request.hyperlinkEdits) {
    const sheetName = resolveSheetName(link.sheetId)
    const sheetLinks = linksBySheet.get(sheetName) ?? []
    sheetLinks.push({ row: link.row, column: link.column, target: link.target })
    linksBySheet.set(sheetName, sheetLinks)
  }
  const hyperlinkEdits = [...linksBySheet].map(([sheetName, links]) => ({
    sheetName,
    edits: links,
  }))
  const cfStates = request.cfStates.map((state) => ({
    sheetName: resolveSheetName(state.sheetId),
    rules: state.rules,
  }))
  const dvStates = request.dvStates.map((state) => ({
    sheetName: resolveSheetName(state.sheetId),
    rules: state.rules,
  }))
  const sheetProtections = request.sheetProtections.map((state) => ({
    sheetName: resolveSheetName(state.sheetId),
    protected: state.protected,
  }))
  const pageSetupStates = request.pageSetupStates.map(({ sheetId, ...state }) => ({
    sheetName: resolveSheetName(sheetId),
    ...state,
  }))
  const noteStates = request.noteStates.map(({ sheetId, notes }) => ({
    sheetName: resolveSheetName(sheetId),
    notes,
  }))
  const visualAdditions = request.visualAdditions.map((addition) => ({
    sheetName: resolveSheetName(addition.sheetId),
    anchor: addition.anchor,
    chart: addition.chart,
    shape: addition.shape,
    image: addition.image,
  }))
  const tableAdditions = request.tableAdditions.map((table) => ({
    sheetName: resolveSheetName(table.sheetId),
    area: table.area,
    name: table.name,
    columnNames: table.columnNames,
    style: table.style,
    bandedRows: table.bandedRows,
  }))
  const pivotAdditions = request.pivotAdditions.map((pivot) => ({
    sheetName: resolveSheetName(pivot.sheetId),
    sourceSheetName: resolveSheetName(pivot.sourceSheetId),
    sourceArea: pivot.sourceArea,
    location: pivot.location,
    name: pivot.name,
    fieldNames: pivot.fieldNames,
    rowFieldIndices: pivot.rowFieldIndices,
    columnFieldIndex: pivot.columnFieldIndex,
    pageFieldIndices: pivot.pageFieldIndices,
    rowItems: pivot.rowItems,
    rowLevelItems: pivot.rowLevelItems,
    rowLines: pivot.rowLines,
    columnItems: pivot.columnItems,
    columnFieldIndices: pivot.columnFieldIndices,
    colLevelItems: pivot.colLevelItems,
    colLines: pivot.colLines,
    groupings: pivot.groupings,
    filters: pivot.filters,
    rowHiddenItems: pivot.rowHiddenItems,
    colHiddenItems: pivot.colHiddenItems,
    values: pivot.values,
  }))
  const sparklineAdditions = request.sparklineAdditions.map(({ sheetId, ...group }) => ({
    sheetName: resolveSheetName(sheetId),
    ...group,
  }))
  // Recalculated formula values: sheetId → file sheet name, the same
  // resolution the cell edits use.
  const formulaValuesBySheet = new Map<
    string,
    { row: number; column: number; value: string | number | boolean | null }[]
  >()
  for (const cell of request.formulaValues) {
    const sheetName = resolveSheetName(cell.sheetId)
    const list = formulaValuesBySheet.get(sheetName) ?? []
    list.push({ row: cell.row, column: cell.column, value: cell.value })
    formulaValuesBySheet.set(sheetName, list)
  }
  const formulaValues = [...formulaValuesBySheet].map(([sheetName, cells]) => ({
    sheetName,
    cells,
  }))
  const mutation = await saveWorkbookViaSidecar({
    client: archiveClient,
    io: hostIo,
    sourcePath: session.hostPath,
    targetPath,
    edits,
    structuralOps,
    chartEdits: request.chartEdits,
    // Located by package-absolute drawingPath, so no sheet-name mapping.
    visualEdits: request.visualEdits,
    sheetPlan,
    filterStates,
    hyperlinkEdits,
    cfStates,
    dvStates,
    sheetProtections,
    definedNamesState: request.definedNamesState,
    visualAdditions,
    pageSetupStates,
    noteStates,
    tableAdditions,
    pivotAdditions,
    sparklineAdditions,
    formulaValues,
    pivotCacheRefreshPaths: request.pivotCacheRefreshPaths,
    // Output-area expansion from layout growth: sheetId → sheet name; the part
    // path is resolved by the gateway.
    pivotRefreshUpdates: request.pivotRefreshUpdates.map((update) => ({
      cachePath: update.cachePath,
      sheetName: resolveSheetName(update.sheetId),
      newOutputRef: update.newOutputRef,
      ...(update.relayout === undefined
        ? {}
        : {
            relayout: (({ sheetId: _sheetId, sourceSheetId, ...rest }) => ({
              ...rest,
              sourceSheetName: resolveSheetName(sourceSheetId),
            }))(update.relayout),
          }),
    })),
  })
  return mutation
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

async function saveWorkbookEdits(request: unknown): Promise<WorkbookSaveResult> {
  const validated = parseSaveRequest(request as never)
  const session = sessionFor(validated.sessionId)

  let targetLogical = session.logicalPath
  const saveAs = validated.mode === 'save-as' || session.suggestSaveAs !== undefined
  if (saveAs) {
    if (isTauri()) {
      // TODO(M3): native save dialog (tauri plugin-dialog) + write to the picked path
      throw new Error('save-as dialog not implemented on tauri yet (TODO M3)')
    }
    // Browser fallback: the suggested name wins; bytes are downloaded AND
    // persisted in the overlay so the saved-as file is reopenable in-session.
    targetLogical = basename(session.suggestSaveAs ?? session.logicalPath)
    if (!targetLogical.endsWith('.xlsx')) targetLogical = `${targetLogical}.xlsx`
  }

  // Drift check: the logical bytes must still be what we opened/saved last.
  if ((await hashLogical(session.logicalPath)) !== session.sha256) {
    throw new Error(
      'The workbook changed on disk after it was opened — use Save As instead.',
    )
  }

  // The pipeline rewrites the host file in place for a plain save; a save-as
  // writes a fresh host file that becomes the new session's staged copy.
  const hostTarget = saveAs
    ? joinPath(dirName(session.hostPath), `.${crypto.randomUUID()}.save-as.xlsx`)
    : session.hostPath
  const mutation = await writeWorkbookTo(session, validated, hostTarget)

  const savedBytes = await readHostFile(hostTarget)
  const digest = sha256Hex(savedBytes)
  if (session.staged || saveAs) {
    if (saveAs) triggerDownload(targetLogical, savedBytes, XLSX_MIME)
    await platform.writeFile(targetLogical, savedBytes)
  }
  await platform.deleteFile(RECOVERY_PREFIX + targetLogical)

  // The sidecar session still streams the pre-save bytes; swap it for a
  // fresh session over the saved file so future reads match the store state.
  sessions.delete(validated.sessionId)
  await xlsxClient.close(validated.sessionId).catch(() => undefined)
  const newHostPath = saveAs ? await stageForSidecar(targetLogical, savedBytes) : session.hostPath
  const file = await openStagedWorkbook(
    newHostPath,
    newHostPath !== targetLogical,
    targetLogical,
    digest,
    undefined,
    undefined,
  )
  return parseSaveResult({ canceled: false, file, touchedEntries: mutation.touchedEntries })
}

/** Crash-recovery copy of a dirty workbook: same pipeline, overlay target, best-effort. */
async function writeWorkbookRecovery(request: unknown): Promise<{ ok: boolean }> {
  let validated: WorkbookSaveRequest
  try {
    validated = parseSaveRequest(request as never)
  } catch {
    return { ok: false }
  }
  const session = sessions.get(validated.sessionId)
  // A converted import has no original file to recover into; its temp copy is enough
  if (!session || session.suggestSaveAs !== undefined) return { ok: false }
  if (isTauri()) {
    // TODO(M3): real recovery dir under appDataDir via a Rust command
    return { ok: false }
  }
  try {
    const workDir = await hostIo.mkdtemp('panoffice-xlsx-recovery-')
    const hostTarget = joinPath(workDir, 'recovery.xlsx')
    await writeWorkbookTo(session, validated, hostTarget)
    await platform.writeFile(RECOVERY_PREFIX + session.logicalPath, await readHostFile(hostTarget))
    await hostIo.remove(workDir, { recursive: true }).catch(() => undefined)
    return { ok: true }
  } catch (error) {
    console.warn('[sheets-api] recovery copy failed:', error)
    return { ok: false }
  }
}

async function closeWorkbook(sessionId: string): Promise<void> {
  if (!isUuid(sessionId)) throw new Error('Invalid workbook session.')
  if (!sessions.delete(sessionId)) return
  await xlsxClient.close(sessionId)
}

/** Content-derived naming for AI-generated workbooks — needs the shell's
 * auto-created untitled flow, which the shell doesn't spawn yet. */
async function autoRenameWorkbook(
  sessionId: string,
  baseName: string,
): Promise<{ renamed: boolean; name?: string }> {
  if (!isUuid(sessionId)) throw new Error('Invalid workbook session.')
  if (typeof baseName !== 'string' || baseName.length === 0 || baseName.length > 100) {
    throw new Error('Invalid workbook name.')
  }
  // TODO(M3): implement once the shell can spawn untitled workbooks (the
  // renderer's AI flow calls this only for those)
  return { renamed: false }
}

// ---- PDF export / external links ----

async function exportPdf(request: unknown): Promise<{ canceled: true } | { canceled: false; path: string }> {
  // Same request validation as the preload, then an honest stub: upstream
  // renders printToPDF from HTML; the Tauri equivalent is the Rust printpdf
  // path (M3 decision, see docs/TAURI-MIGRATION.md §4).
  if (
    !isRecord(request) ||
    typeof request.fileName !== 'string' ||
    request.fileName.length === 0 ||
    request.fileName.length > 255 ||
    typeof request.html !== 'string' ||
    request.html.length === 0 ||
    request.html.length > 20_000_000 ||
    typeof request.landscape !== 'boolean' ||
    !isPdfPageSize(request.pageSize) ||
    !isRecord(request.margins) ||
    !['top', 'bottom', 'left', 'right'].every((edge) => {
      const value = (request.margins as Record<string, unknown>)[edge]
      return typeof value === 'number' && value >= 0 && value <= 3
    }) ||
    typeof request.scale !== 'number' ||
    request.scale < 0.1 ||
    request.scale > 2
  ) {
    throw new Error('Invalid PDF export request.')
  }
  throw new Error('PDF export is not available in the Tauri port yet (TODO M3)')
}

function openExternal(url: string): Promise<void> {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw new Error('Only http(s) links can be opened.')
  }
  window.open(url, '_blank', 'noopener')
  return Promise.resolve()
}

// ---- local images (AI insert-image tool) ----

function sniffImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 4)) === 'GIF8') {
    return 'image/gif'
  }
  return null
}

async function readLocalImage(request: unknown): Promise<{
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif'
  base64: string
}> {
  if (
    !isRecord(request) ||
    typeof request.path !== 'string' ||
    request.path.length === 0 ||
    request.path.length > 1024
  ) {
    throw new Error('Invalid local image request.')
  }
  const bytes = await platform.readFile(request.path).catch(() => null)
  if (!bytes) throw new Error(`Image file not found: ${request.path}`)
  if (bytes.byteLength > LOCAL_IMAGE_MAX_BYTES) {
    throw new Error('Image exceeds 20MB and cannot be inserted.')
  }
  const mediaType = sniffImageType(bytes)
  if (mediaType === null) throw new Error('The file is not a PNG/JPEG/GIF image.')
  return { mediaType, base64: bytesToBase64(bytes) }
}

// ---- Genspark login / web search (need a Rust-side network proxy, M3) ----

function aiGskStatus(_withEmail?: boolean): Promise<GenSparkAccountStatus> {
  // TODO(M3): gsk auth state lives with the CLI on the host; no webview analog
  return Promise.resolve({ loggedIn: false })
}

function aiGskLogin(): Promise<void> {
  // TODO(M3): upstream opens the system browser for the OAuth flow
  console.debug('[sheets-api] aiGskLogin (stub, TODO M3)')
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

// ---- chat attachments (same overlay pattern as the docs port) ----

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
    const path = `${ATTACHMENT_DIR}/${file.name}`
    const { meta, error } = statAttachment(path, bytes.byteLength)
    if (error) {
      rejected.push(error)
      continue
    }
    await platform.writeFile(path, bytes)
    accepted.push(meta!)
  }
  return parseAttachmentAddResult(collectAttachments(accepted, rejected))
}

async function addAttachmentPaths(paths: string[]): Promise<AttachmentAddResult> {
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > 50 ||
    paths.some((p) => typeof p !== 'string' || p.length === 0 || p.length > 1024)
  ) {
    throw new Error('Invalid attachment paths.')
  }
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
  return parseAttachmentAddResult(collectAttachments(accepted, rejected))
}

async function addPastedImage(data: ArrayBuffer, ext: string): Promise<AttachmentAddResult> {
  if (!(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > 64 * 1024 * 1024) {
    throw new Error('Invalid pasted image data.')
  }
  if (typeof ext !== 'string' || ext.length === 0 || ext.length > 8) {
    throw new Error('Invalid pasted image extension.')
  }
  const cleanExt = ext.toLowerCase()
  const bytes = new Uint8Array(data)
  if (!ATTACHMENT_IMAGE_EXTS.has(cleanExt) || bytes.byteLength === 0) {
    return parseAttachmentAddResult(collectAttachments([], ['not an image']))
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const path = `${ATTACHMENT_DIR}/pasted-${stamp}-${++pastedImageSeq}.${cleanExt}`
  const { meta, error } = statAttachment(path, bytes.byteLength)
  if (!meta) return parseAttachmentAddResult(collectAttachments([], [error!]))
  await platform.writeFile(path, bytes)
  return parseAttachmentAddResult(collectAttachments([meta], []))
}

async function readAttachment(
  path: string,
  offset: number,
  maxChars: number,
): Promise<AttachmentReadResult> {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) {
    throw new Error('Invalid attachment path.')
  }
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
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) {
    throw new Error('Invalid attachment path.')
  }
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
function getPathForFile(_file: File): string {
  // TODO: use the Tauri drag-drop event (webview.onDragDropEvent) to recover real paths
  return null as unknown as string
}

// ---- events: menu actions / close handshake / renames ----

type MenuHandler = (action: MenuAction) => void

const menuHandlers = new Set<MenuHandler>()
/** The shell's initial 'open' can arrive before the renderer subscribed; deliver on registration */
let queuedMenuAction: MenuAction | null = null

function onMenuAction(callback: MenuHandler): () => void {
  menuHandlers.add(callback)
  if (queuedMenuAction !== null) {
    const action = queuedMenuAction
    queuedMenuAction = null
    queueMicrotask(() => callback(action))
  }
  return () => menuHandlers.delete(callback)
}

/**
 * Fire a menu action as the native app menu would. Used by SheetsApp to route
 * `#/sheets?src=…` into the renderer's open flow (the shell has no native
 * menu yet — TODO M3 tauri plugin-menu).
 */
export function emitSheetsMenuAction(action: MenuAction): void {
  if (menuHandlers.size === 0) {
    queuedMenuAction = action
    return
  }
  for (const handler of menuHandlers) handler(action)
}

function onWorkbookRenamed(_handler: (newName: string) => void): () => void {
  // Never fires: autoRenameWorkbook is the only source and it's a no-op stub
  // until the shell spawns untitled workbooks (TODO M3)
  return () => {}
}

function notifyPendingEdits(count: number): void {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return
  // TODO(M3): feed the close guard once the shell owns window lifecycle
}

function onCloseSaveRequest(_handler: () => void): () => void {
  // TODO(M3): real close guard with the window lifecycle
  return () => {}
}

function reportCloseSaveResult(ok: boolean): void {
  console.debug('[sheets-api] reportCloseSaveResult (stub):', ok)
}

let newBlankConsumed = false

function consumeNewBlankWorkbook(): Promise<boolean> {
  // TODO(M3): real new-blank tab flow when the shell spawns sheets views itself
  if (newBlankConsumed) return Promise.resolve(false)
  newBlankConsumed = true
  return Promise.resolve(false)
}

// ---- language ----

type SheetsLang = 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar'

function getLanguage(): Promise<SheetsLang> {
  const stored = localStorage.getItem(LANG_KEY)
  const lang = (LANGS as readonly string[]).includes(stored ?? '') ? (stored as SheetsLang) : 'zh'
  return Promise.resolve(lang)
}

// No language switcher in the shell yet, so handlers never fire; kept for API parity.
const languageHandlers = new Set<(lang: SheetsLang) => void>()

function onLanguageChanged(handler: (lang: SheetsLang) => void): () => void {
  languageHandlers.add(handler)
  return () => languageHandlers.delete(handler)
}

// ---- window.projectApi: chat-history persistence over localStorage ----
//
// Same rationale as the docs port: upstream this is the node:fs-backed
// ProjectStore under userData; the sheets renderer only uses the four chat
// methods. Sheets gets its own storage key so histories don't mix with docs.

const CHAT_KEY = 'panoffice.sheets.chats'

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
  // ── P1 extensions: shell home-screen features, not used by the sheets
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

/** Install window.desktopApi + window.projectApi. Called once by installBridge() before any renderer code runs. */
export function installSheetsApi(): void {
  const ai = createAiBridge()
  const api: DesktopApi = {
    getLanguage,
    onLanguageChanged,
    selectWorkbook,
    readWorkbookRange,
    readWorkbookFormulas,
    recalcWorkbook,
    readWorkbookMedia,
    readPivotDefinition,
    readLocalImage,
    saveWorkbookEdits,
    writeWorkbookRecovery,
    autoRenameWorkbook,
    exportPdf,
    closeWorkbook,
    openExternal,
    onMenuAction,
    onWorkbookRenamed,
    notifyPendingEdits,
    onCloseSaveRequest,
    reportCloseSaveResult,
    consumeNewBlankWorkbook,
    getAiSettings: ai.getAiSettings,
    setAiSettings: ai.setAiSettings,
    aiChat: ai.aiChat,
    aiStream: ai.aiStream,
    aiStreamCancel: ai.aiStreamCancel,
    aiGskStatus,
    aiGskLogin,
    webSearch,
    onAiStream: ai.onAiStream,
    pickAttachments,
    addAttachmentPaths,
    addPastedImage,
    readAttachment,
    readAttachmentImage,
    getPathForFile,
  }
  window.desktopApi = api
  // One projectApi per shell: the docs bridge installs it first; the sheets
  // chat methods are identical modulo storage key, so reuse wins over split
  // histories (matches the upstream unified shell's single ProjectStore).
  window.projectApi ??= projectApi
}
