/**
 * Host file-IO abstraction for the xlsx gateway (xlsx-package-io.ts).
 *
 * Upstream the gateway called node:fs directly (it ran in the Electron main
 * process). In the Tauri port the gateway runs in the webview, so every fs
 * touch goes through this interface:
 *  - webview: src/bridge/xlsx-rpc.ts implements it over the xlsx-RPC channel
 *    (`host.*` commands — the dev server or the Rust xlsx_rpc command runs
 *    them against the real disk),
 *  - tests: gateway/host-io-node.ts backs it with node:fs.
 *
 * Paths are host-side and joined with '/'; both node and Rust accept forward
 * slashes on every supported platform.
 */
export interface HostIo {
  /** Create a fresh temp directory whose name starts with `prefix`; returns its path. */
  mkdtemp(prefix: string): Promise<string>
  /** mkdir -p */
  mkdir(path: string): Promise<void>
  readText(path: string): Promise<string>
  /** UTF-8 write when content is a string, raw bytes otherwise */
  writeFile(path: string, content: string | Uint8Array): Promise<void>
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

export function dirName(path: string): string {
  const index = path.replace(/\\/g, '/').lastIndexOf('/')
  return index <= 0 ? '.' : path.slice(0, index)
}
