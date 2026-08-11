#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

const [base = 'http://127.0.0.1:8791', origin = '', fixture] = process.argv.slice(2)
if (!fixture) {
  throw new Error('usage: xlsx-sidecar-smoke.mjs <base-url> <origin-or-empty> <fixture.xlsx>')
}

async function rpc(command) {
  const response = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ version: 1, requestId: randomUUID(), ...command }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message ?? `XLSX RPC failed with HTTP ${response.status}`)
  }
  return payload.result
}

const bytes = await readFile(fixture)
const staged = await rpc({
  command: 'host.stage',
  path: basename(fixture),
  base64: bytes.toString('base64'),
})
const opened = await rpc({ command: 'open', path: staged.path })
if (!opened?.sessionId || !Array.isArray(opened.sheets) || opened.sheets.length === 0) {
  throw new Error('XLSX engine returned no workbook session or sheets')
}

try {
  const firstSheet = opened.sheets[0]
  await rpc({
    command: 'read_range',
    sessionId: opened.sessionId,
    sheetId: firstSheet.id,
    range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
  })
  console.log(
    JSON.stringify({
      ok: true,
      workbook: basename(fixture),
      sheets: opened.sheets.length,
      firstSheet: firstSheet.name,
    }),
  )
} finally {
  await rpc({ command: 'close', sessionId: opened.sessionId })
}
