#!/usr/bin/env node
/**
 * xlsx sidecar dev server — the browser-mode half of the sheets xlsx-RPC
 * channel (the Tauri mode half is the `xlsx_rpc` Rust command in src-tauri).
 *
 *   POST /rpc  — one newline-JSON request envelope in, one response line out:
 *   {version, requestId, command, ...} → {version, requestId, ok, result|error}
 *
 * Sidecar commands are forwarded to a single long-running xlsx-sidecar child
 * over stdio (serialized writes, requestId matching, 30s timeout — 180s for
 * archive commands, mirroring src/main/xlsx-sidecar-client.ts upstream).
 * `host.*` commands are answered by the server itself: they are the fs
 * touchpoints the in-webview gateway needs (temp dirs, plan content files,
 * staging URL-ish paths so the sidecar sees real files).
 *
 * Dev-only: binds 127.0.0.1, no auth — same trust level as the vite dev
 * server. Port: 8791, override with XLSX_SIDECAR_PORT. Sidecar binary:
 * XLSX_SIDECAR_PATH or native/xlsx-engine/target/release/xlsx-sidecar.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const PROTOCOL_VERSION = 1
const REQUEST_TIMEOUT_MS = 30_000
/** Archive commands stream whole workbooks; large files need more headroom. */
const ARCHIVE_TIMEOUT_MS = 180_000
const MAX_STDERR_LENGTH = 8_192
const MAX_BODY_BYTES = 512 * 1024 * 1024

const ARCHIVE_COMMANDS = new Set([
  'convert_workbook',
  'archive_manifest',
  'read_entries',
  'scan_entries',
  'save_archive',
  'recalc_cells',
])

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.XLSX_SIDECAR_PORT ?? 8791)
const SIDECAR_PATH =
  process.env.XLSX_SIDECAR_PATH ??
  join(rootDir, 'native', 'xlsx-engine', 'target', 'release', 'xlsx-sidecar')
const STAGE_DIR = join(tmpdir(), 'panoffice-xlsx-stage')

// ---- sidecar child (one instance, lazily spawned, respawned after exit) ----

let child = null
let stderrTail = ''
const pending = new Map() // requestId → { resolve, reject, timeout }

function rejectPending(error) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timeout)
    entry.reject(error)
  }
  pending.clear()
}

function ensureSidecar() {
  if (child && !child.killed) return child
  const spawned = spawn(SIDECAR_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  child = spawned
  stderrTail = ''
  const lines = createInterface({ input: spawned.stdout })
  lines.on('line', (line) => {
    let response
    try {
      response = JSON.parse(line)
    } catch {
      rejectPending(new Error('XLSX sidecar returned invalid JSON.'))
      return
    }
    const entry = pending.get(response.requestId)
    if (!entry) return
    clearTimeout(entry.timeout)
    pending.delete(response.requestId)
    entry.resolve(response)
  })
  spawned.stderr.setEncoding('utf8')
  spawned.stderr.on('data', (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-MAX_STDERR_LENGTH)
  })
  spawned.once('error', (error) => {
    child = null
    rejectPending(error)
  })
  spawned.once('exit', (code, signal) => {
    child = null
    const detail = stderrTail.trim()
    rejectPending(
      new Error(
        detail
          ? `XLSX sidecar exited: ${detail}`
          : `XLSX sidecar exited with code ${String(code)} and signal ${String(signal)}.`,
      ),
    )
  })
  return spawned
}

/** Send one command to the sidecar; resolves with its raw response line. */
function sidecarRequest(envelope) {
  const timeoutMs = ARCHIVE_COMMANDS.has(envelope.command)
    ? ARCHIVE_TIMEOUT_MS
    : REQUEST_TIMEOUT_MS
  const process_ = ensureSidecar()
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(envelope.requestId)
      reject(new Error('XLSX sidecar request timed out.'))
    }, timeoutMs)
    pending.set(envelope.requestId, { resolve: resolvePromise, reject, timeout })
    process_.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
      if (!error) return
      const entry = pending.get(envelope.requestId)
      if (!entry) return
      clearTimeout(entry.timeout)
      pending.delete(envelope.requestId)
      entry.reject(error)
    })
  })
}

// ---- host.* commands (the fs the in-webview gateway can't touch) ----

function okResult(result) {
  return { ok: true, result }
}

const hostCommands = {
  /**
   * Ensure `path` exists as a real file the sidecar can open. Real on-disk
   * paths pass through; anything else (vite URL-ish paths, overlay keys) is
   * staged under a temp dir keyed by the logical path, keeping the basename.
   */
  async 'host.stage'(args) {
    const logical = args.path
    if (typeof logical !== 'string' || logical.length === 0) {
      throw new Error('host.stage: path must be a non-empty string')
    }
    if (isAbsolute(logical)) {
      const info = await stat(logical).catch(() => null)
      if (info?.isFile()) return okResult({ path: logical })
    }
    const key = createHash('sha256').update(logical).digest('hex').slice(0, 16)
    const dir = join(STAGE_DIR, key)
    await mkdir(dir, { recursive: true })
    const staged = join(dir, basename(logical).replace(/[^\w.-]/g, '_') || 'workbook.xlsx')
    await writeFile(staged, Buffer.from(String(args.base64 ?? ''), 'base64'))
    return okResult({ path: staged })
  },
  async 'host.mkdtemp'(args) {
    const prefix = typeof args.prefix === 'string' ? args.prefix : 'panoffice-xlsx-'
    return okResult({ path: await mkdtemp(join(tmpdir(), prefix)) })
  },
  async 'host.mkdir'(args) {
    await mkdir(String(args.path), { recursive: true })
    return okResult({})
  },
  async 'host.read_text'(args) {
    return okResult({ text: await readFile(String(args.path), 'utf8') })
  },
  async 'host.read_file'(args) {
    return okResult({ base64: (await readFile(String(args.path))).toString('base64') })
  },
  async 'host.write_file'(args) {
    const path = String(args.path)
    if (typeof args.text === 'string') await writeFile(path, args.text, 'utf8')
    else await writeFile(path, Buffer.from(String(args.base64 ?? ''), 'base64'))
    return okResult({})
  },
  async 'host.remove'(args) {
    await rm(String(args.path), { recursive: args.recursive === true, force: true })
    return okResult({})
  },
  async 'host.rename'(args) {
    await rename(String(args.from), String(args.to))
    return okResult({})
  },
}

// ---- HTTP endpoint ----

function respond(res, status, body) {
  const payload = status === 204 ? '' : JSON.stringify(body)
  try {
    res.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    })
    res.end(payload)
  } catch {
    // The webview may have reloaded mid-request; a dead socket is not fatal.
  }
}

process.on('unhandledRejection', (error) => {
  console.error('[xlsx-sidecar-server] unhandled rejection:', error)
})

async function handleRpc(body) {
  let envelope
  try {
    envelope = JSON.parse(body)
  } catch {
    return { status: 400, body: { ok: false, error: { code: 'bad_json', message: 'Invalid JSON body.' } } }
  }
  const requestId = typeof envelope.requestId === 'string' ? envelope.requestId : randomUUID()
  const fail = (code, message) => ({
    status: 200,
    body: { version: PROTOCOL_VERSION, requestId, ok: false, error: { code, message } },
  })
  if (envelope.version !== PROTOCOL_VERSION || typeof envelope.command !== 'string') {
    return fail('bad_request', 'Invalid XLSX RPC envelope.')
  }
  try {
    if (envelope.command.startsWith('host.')) {
      const handler = hostCommands[envelope.command]
      if (!handler) return fail('unknown_host_command', `Unknown host command: ${envelope.command}`)
      const result = await handler(envelope)
      return { status: 200, body: { version: PROTOCOL_VERSION, requestId, ...result } }
    }
    const response = await sidecarRequest(envelope)
    return { status: 200, body: response }
  } catch (error) {
    return fail('rpc_failed', error instanceof Error ? error.message : String(error))
  }
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    respond(res, 204, {})
    return
  }
  if (req.method === 'GET' && req.url === '/health') {
    respond(res, 200, { ok: true, sidecar: SIDECAR_PATH })
    return
  }
  if (req.method !== 'POST' || req.url !== '/rpc') {
    respond(res, 404, { ok: false, error: { code: 'not_found', message: 'POST /rpc only.' } })
    return
  }
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      req.destroy(new Error('request too large'))
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    handleRpc(Buffer.concat(chunks).toString('utf8'))
      .then(({ status, body }) => respond(res, status, body))
      .catch((error) =>
        respond(res, 500, {
          ok: false,
          error: { code: 'server_error', message: error instanceof Error ? error.message : String(error) },
        }),
      )
  })
  req.on('error', (error) => {
    respond(res, 413, {
      ok: false,
      error: { code: 'body_error', message: error instanceof Error ? error.message : String(error) },
    })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[xlsx-sidecar-server] listening on http://127.0.0.1:${PORT} (sidecar: ${SIDECAR_PATH})`)
})

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
