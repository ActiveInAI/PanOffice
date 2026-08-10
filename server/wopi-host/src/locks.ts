/**
 * WOPI lock manager: in-memory map persisted to `<dataDir>/.wopi-locks.json`
 * (atomic tmp+rename) so locks survive restarts. Locks expire after `ttlMs`
 * unless refreshed; expired locks are pruned lazily on access.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface LockEntry {
  token: string
  /** epoch ms when the lock expires */
  expiresAt: number
}

export type LockResult = { ok: true } | { ok: false; current: LockEntry }
export type ReleaseResult = 'ok' | 'mismatch' | 'not-locked'

export class LockManager {
  private readonly file: string
  private readonly ttlMs: number
  private readonly locks = new Map<string, LockEntry>()

  private constructor(file: string, ttlMs: number) {
    this.file = file
    this.ttlMs = ttlMs
  }

  static async load(file: string, ttlMs: number): Promise<LockManager> {
    const mgr = new LockManager(file, ttlMs)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return mgr // no persisted state yet
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, LockEntry>
      const now = Date.now()
      for (const [id, entry] of Object.entries(parsed)) {
        if (entry && typeof entry.token === 'string' && entry.expiresAt > now) {
          mgr.locks.set(id, entry)
        }
      }
    } catch {
      // corrupt lock file: start empty rather than crash the host
    }
    return mgr
  }

  /** Current non-expired lock for a file, or null. */
  get(fileId: string): LockEntry | null {
    const entry = this.locks.get(fileId)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.locks.delete(fileId)
      void this.persist()
      return null
    }
    return entry
  }

  /** Take or re-assert a lock. Same token = idempotent success (and refresh). */
  async lock(fileId: string, token: string): Promise<LockResult> {
    const current = this.get(fileId)
    if (current && current.token !== token) return { ok: false, current }
    const entry: LockEntry = { token, expiresAt: Date.now() + this.ttlMs }
    this.locks.set(fileId, entry)
    await this.persist()
    return { ok: true }
  }

  async unlock(fileId: string, token: string): Promise<ReleaseResult> {
    const current = this.get(fileId)
    if (!current) return 'not-locked'
    if (current.token !== token) return 'mismatch'
    this.locks.delete(fileId)
    await this.persist()
    return 'ok'
  }

  async refresh(fileId: string, token: string): Promise<ReleaseResult> {
    const current = this.get(fileId)
    if (!current) return 'not-locked'
    if (current.token !== token) return 'mismatch'
    current.expiresAt = Date.now() + this.ttlMs
    await this.persist()
    return 'ok'
  }

  private persistChain: Promise<void> = Promise.resolve()
  private persistCounter = 0

  /** Serialize persists: get() can trigger a lazy-prune persist that would
   *  otherwise race a lock()/unlock() persist on the same tmp file. */
  private persist(): Promise<void> {
    const run = this.persistChain.then(() => this.persistNow())
    this.persistChain = run.catch(() => undefined)
    return run
  }

  private async persistNow(): Promise<void> {
    const obj: Record<string, LockEntry> = {}
    const now = Date.now()
    for (const [id, entry] of this.locks) {
      if (entry.expiresAt > now) obj[id] = entry
    }
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}-${this.persistCounter++}`
    await writeFile(tmp, JSON.stringify(obj, null, 2))
    await rename(tmp, this.file)
  }
}
