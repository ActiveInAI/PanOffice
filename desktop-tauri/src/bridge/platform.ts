/**
 * Byte-store abstraction behind the bridge shims.
 *
 * Two backends:
 *  - Tauri: the Rust `read_file`/`write_file` commands (real disk).
 *  - Browser (vite dev / headless e2e): an IndexedDB overlay keyed by path.
 *    Saves write into the overlay; reads check the overlay first and fall
 *    back to fetch() for URL-ish paths (vite serves `public/`, so
 *    `/fixtures/hello.pdf` resolves there). The overlay is what makes
 *    save → reopen verifiable without a native host.
 */
import { invoke } from '@tauri-apps/api/core'

/** True inside the Tauri webview (injected by the runtime), false in a plain browser. */
export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window
}

/**
 * Remote (WOPI-hosted) file: an absolute http(s) URL. Reads always go to the
 * server (no IndexedDB shadowing), writes POST the bytes back (PutFile-style),
 * so a save really lands on the host's disk — this is what the in-browser
 * PDF editor uses when opened from the wopi-host file list.
 */
export function isRemoteUrl(path: string): boolean {
  return /^https?:\/\//i.test(path)
}

// ---- IndexedDB overlay (browser backend) ----

const DB_NAME = 'panoffice'
const DB_STORE = 'files'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
  })
  return dbPromise
}

function idbGet(path: string): Promise<Uint8Array | null> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(path)
        req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null)
        req.onerror = () => reject(req.error ?? new Error('indexedDB get failed'))
      }),
  )
}

function idbPut(path: string, bytes: Uint8Array): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(bytes, path)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error ?? new Error('indexedDB put failed'))
      }),
  )
}

function idbDelete(path: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(path)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error ?? new Error('indexedDB delete failed'))
      }),
  )
}

/**
 * Remote save. WOPI contents URLs (…/wopi/files/<id>/contents?access_token=…)
 * get proper lock citizenship — LOCK → PUT with X-WOPI-Lock → UNLOCK — so a
 * save neither clobbers a Collabora session's file nor trips the host's lock
 * check. A 409 on LOCK means another session holds the file; that surfaces as
 * an honest save error. Non-WOPI remote URLs keep the plain PutFile-style POST.
 */
async function writeRemoteFile(path: string, bytes: Uint8Array): Promise<void> {
  const wopi = /^(https?:\/\/[^?]+\/wopi\/files\/[^/]+)\/contents(\?.*)?$/i.exec(path)
  if (!wopi) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes as unknown as BodyInit,
    })
    if (!res.ok) throw new Error(`save failed: ${path} (HTTP ${res.status})`)
    return
  }
  const fileUrl = wopi[1]!
  const query = wopi[2] ?? ''
  const lockToken = `panoffice-web-${crypto.randomUUID()}`
  const lockRes = await fetch(`${fileUrl}${query}`, {
    method: 'POST',
    headers: { 'X-WOPI-Override': 'LOCK', 'X-WOPI-Lock': lockToken },
  })
  if (lockRes.status === 409) {
    throw new Error(`save failed: ${path} (locked by another editing session)`)
  }
  if (!lockRes.ok) throw new Error(`save failed: ${path} (LOCK HTTP ${lockRes.status})`)
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-WOPI-Lock': lockToken },
      body: bytes as unknown as BodyInit,
    })
    if (!res.ok) throw new Error(`save failed: ${path} (HTTP ${res.status})`)
  } finally {
    await fetch(`${fileUrl}${query}`, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'UNLOCK', 'X-WOPI-Lock': lockToken },
    }).catch(() => undefined)
  }
}

// ---- public API ----

export const platform = {
  /**
   * Read a file as bytes. Browser mode checks the save overlay first, then
   * fetches the path as a URL (vite serves `public/` at the root).
   */
  async readFile(path: string): Promise<Uint8Array> {
    if (isTauri()) {
      // Rust returns Vec<u8>, which deserializes as a plain number array
      const nums = await invoke<number[]>('read_file', { path })
      return new Uint8Array(nums)
    }
    if (isRemoteUrl(path)) {
      const res = await fetch(path)
      if (!res.ok) throw new Error(`read failed: ${path} (HTTP ${res.status})`)
      return new Uint8Array(await res.arrayBuffer())
    }
    const overlaid = await idbGet(path)
    if (overlaid) return overlaid
    const res = await fetch(path)
    if (!res.ok) throw new Error(`read failed: ${path} (HTTP ${res.status})`)
    return new Uint8Array(await res.arrayBuffer())
  },

  /**
   * Persist bytes. Browser mode: remote URLs POST back to the server (the
   * response must be ok; e.g. a 409 lock conflict surfaces to the caller);
   * everything else writes the overlay only — nothing hits disk.
   */
  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    if (isTauri()) {
      await invoke('write_file', { path, bytes: Array.from(bytes) })
      return
    }
    if (isRemoteUrl(path)) {
      await writeRemoteFile(path, bytes)
      return
    }
    await idbPut(path, bytes)
  },

  /**
   * Overlay-only existence check (browser backend). Used for unique-name
   * generation and recovery copies; URL-ish paths that are only fetchable
   * report false.
   * TODO(M3): back with a Rust `stat` command for the Tauri backend.
   */
  async exists(path: string): Promise<boolean> {
    if (isTauri()) return false
    return (await idbGet(path)) !== null
  },

  /**
   * Remove bytes previously written via writeFile. Browser backend only —
   * there is no Rust remove command yet.
   * TODO(M3): back with a Rust `remove_file` command for the Tauri backend.
   */
  async deleteFile(path: string): Promise<void> {
    if (isTauri()) {
      console.debug('[platform] deleteFile (no-op on tauri, TODO M3):', path)
      return
    }
    await idbDelete(path)
  },
}
