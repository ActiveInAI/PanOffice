/**
 * xlsx-RPC client — the webview half of the sheets sidecar channel.
 *
 * One request/response envelope for two transports:
 *  - Tauri: `invoke('xlsx_rpc', { request })` — the Rust command owns the
 *    sidecar child (spawn/reuse, newline-JSON framing, requestId matching,
 *    30s/180s timeouts) and answers `host.*` commands itself,
 *  - browser (vite dev / headless e2e): HTTP POST to the dev server
 *    (tools/xlsx-sidecar-server.mjs), which does the same in Node.
 *
 * `host.*` commands are the fs touchpoints the gateway save pipeline needs
 * (temp dirs, plan content files, staging logical paths so the sidecar sees
 * real files); everything else is forwarded to the sidecar verbatim. The
 * semantics mirror desktop/apps/sheets/src/main/xlsx-sidecar-client.ts.
 */
import { invoke } from '@tauri-apps/api/core'

import type { ArchiveClient } from '../apps/sheets/gateway/xlsx-package-io'
import type { HostIo } from '../apps/sheets/gateway/host-io'
import { base64ToBytes, bytesToBase64 } from '../apps/sheets/gateway/sha256'
import { isTauri } from './platform'

const PROTOCOL_VERSION = 1
const REQUEST_TIMEOUT_MS = 30_000
/** Archive commands stream whole workbooks; large files need more headroom. */
const ARCHIVE_TIMEOUT_MS = 180_000
/** Webview-side backstop on top of the host's own timeout (host errors win). */
const TIMEOUT_MARGIN_MS = 10_000

const ARCHIVE_COMMANDS = new Set([
  'convert_workbook',
  'archive_manifest',
  'read_entries',
  'scan_entries',
  'save_archive',
  'recalc_cells',
  // answered by the WOPI host itself: server-side staging of a store file
  'host.stage_store_file',
])

/** XLSX-service base URL; production uses the WOPI host's same-origin proxy. */
const SERVER_URL =
  (import.meta.env.VITE_XLSX_SIDECAR_URL as string | undefined) ?? 'http://127.0.0.1:8791'

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

export interface XlsxRpcResponse {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code?: string; readonly message?: string }
}

/**
 * Send one command down the channel; resolves with the sidecar/host `result`
 * or rejects with its error message, exactly like the upstream Node client.
 */
export async function xlsxRpc(command: Readonly<Record<string, unknown>>): Promise<unknown> {
  const kind = typeof command.command === 'string' ? command.command : ''
  const timeoutMs = (ARCHIVE_COMMANDS.has(kind) ? ARCHIVE_TIMEOUT_MS : REQUEST_TIMEOUT_MS) +
    TIMEOUT_MARGIN_MS
  const envelope = {
    version: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    ...command,
  }
  const response = await withTimeout(
    isTauri() ? tauriRoundTrip(envelope) : httpRoundTrip(envelope),
    timeoutMs,
  )
  if (response.ok) return response.result
  throw new Error(response.error?.message ?? 'XLSX sidecar request failed.')
}

async function tauriRoundTrip(envelope: Readonly<Record<string, unknown>>): Promise<XlsxRpcResponse> {
  // Rust returns the response payload (or throws the sidecar's error message);
  // wrapping it keeps one response shape for both transports.
  try {
    const result = await invoke<unknown>('xlsx_rpc', { request: envelope })
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: { message: errMsg(err) } }
  }
}

async function httpRoundTrip(envelope: Readonly<Record<string, unknown>>): Promise<XlsxRpcResponse> {
  let res: Response
  try {
    res = await fetch(`${SERVER_URL}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    })
  } catch (err) {
    throw new Error(
      `XLSX service unreachable at ${SERVER_URL}: ${errMsg(err)}`,
    )
  }
  const parsed = (await res.json().catch(() => null)) as {
    ok?: boolean
    result?: unknown
    error?: { message?: string }
  } | null
  if (!res.ok) {
    throw new Error(parsed?.error?.message ?? `XLSX service answered HTTP ${res.status}`)
  }
  if (parsed?.ok === true) return { ok: true, result: parsed.result }
  return { ok: false, error: { message: parsed?.error?.message ?? 'XLSX request failed.' } }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('XLSX sidecar request timed out.')), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ---- typed wrappers (mirror XlsxSidecarClient's method surface) ----

export const xlsxClient = {
  open: (path: string): Promise<unknown> => xlsxRpc({ command: 'open', path }),
  readRange: (input: {
    sessionId: string
    sheetId: string
    range: { startRow: number; endRow: number; startColumn: number; endColumn: number }
  }): Promise<unknown> => xlsxRpc({ command: 'read_range', ...input }),
  readFormulaCells: (input: { sessionId: string; sheetId: string }): Promise<unknown> =>
    xlsxRpc({ command: 'read_formula_cells', ...input }),
  readMedia: (input: { sessionId: string; visualId: string }): Promise<unknown> =>
    xlsxRpc({ command: 'read_media', ...input }),
  recalcCells: (input: {
    path: string
    edits: readonly { sheet: string; row: number; column: number; input: string }[]
    reads: readonly {
      sheet: string
      range: { startRow: number; endRow: number; startColumn: number; endColumn: number }
    }[]
  }): Promise<unknown> => xlsxRpc({ command: 'recalc_cells', ...input }),
  convertWorkbook: (input: { path: string; targetPath: string }): Promise<unknown> =>
    xlsxRpc({ command: 'convert_workbook', ...input }),
  close: (sessionId: string): Promise<unknown> => xlsxRpc({ command: 'close', sessionId }),
}

/** ArchiveClient over the RPC channel — the gateway's save path consumes this. */
export function createRpcArchiveClient(): ArchiveClient {
  return {
    archiveManifest: (path) => xlsxRpc({ command: 'archive_manifest', path }),
    readEntries: (input) => xlsxRpc({ command: 'read_entries', ...input }),
    scanEntries: (input) => xlsxRpc({ command: 'scan_entries', ...input }),
    saveArchive: (input) => xlsxRpc({ command: 'save_archive', ...input }),
  }
}

async function hostCall(command: string, args: Record<string, unknown>): Promise<unknown> {
  return xlsxRpc({ command, ...args })
}

/** HostIo over the RPC channel — temp dirs and plan content files on the host. */
export function createRpcHostIo(): HostIo {
  return {
    mkdtemp: async (prefix) => {
      const result = (await hostCall('host.mkdtemp', { prefix })) as { path: string }
      return result.path
    },
    mkdir: async (path) => {
      await hostCall('host.mkdir', { path })
    },
    readText: async (path) => {
      const result = (await hostCall('host.read_text', { path })) as { text: string }
      return result.text
    },
    writeFile: async (path, content) => {
      if (typeof content === 'string') await hostCall('host.write_file', { path, text: content })
      else await hostCall('host.write_file', { path, base64: bytesToBase64(content) })
    },
    remove: async (path, opts) => {
      await hostCall('host.remove', { path, recursive: opts?.recursive ?? false })
    },
    rename: async (from, to) => {
      await hostCall('host.rename', { from, to })
    },
  }
}

/**
 * Ensure the logical path the webview reads/writes (overlay key or real path)
 * exists as a real file the sidecar can open; returns the host-side path.
 * Tauri passes real paths through untouched; the dev server stages the bytes
 * under a temp directory keyed by the logical path.
 */
export async function stageForSidecar(logicalPath: string, bytes: Uint8Array): Promise<string> {
  const result = (await hostCall('host.stage', {
    path: logicalPath,
    base64: bytesToBase64(bytes),
  })) as { path: string }
  return result.path
}

/** Read a host-side file back into the webview (saved workbook bytes). */
export async function readHostFile(path: string): Promise<Uint8Array> {
  const result = (await hostCall('host.read_file', { path })) as { base64: string }
  return base64ToBytes(result.base64)
}
