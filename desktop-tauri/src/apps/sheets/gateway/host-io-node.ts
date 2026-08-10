/**
 * node:fs-backed HostIo — used by the vitest suites (the gateway's original
 * runtime). The webview uses the RPC-backed implementation in
 * src/bridge/xlsx-rpc.ts instead. Never imported from renderer code, so the
 * node: imports never reach the browser bundle.
 */
import { mkdtemp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HostIo } from './host-io'

export function createNodeHostIo(): HostIo {
  return {
    mkdtemp: (prefix) => mkdtemp(join(tmpdir(), prefix)),
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
    readText: (path) => readFile(path, 'utf8'),
    writeFile: (path, content) =>
      typeof content === 'string' ? writeFile(path, content, 'utf8') : writeFile(path, content),
    remove: (path, opts) => rm(path, { recursive: opts?.recursive ?? false, force: true }),
    // fsync + rename, mirroring the upstream promoteFileAtomically
    rename: async (from, to) => {
      const handle = await open(from, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(from, to)
    },
  }
}
