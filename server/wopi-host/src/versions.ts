/**
 * Version archive: before every successful PutFile the previous bytes are
 * copied to `<dataDir>/.versions/<file>/<versionId>`, where versionId is the
 * mtime-based id CheckFileInfo already exposes. Oldest archives are pruned
 * beyond `cap` per file.
 */
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface VersionInfo {
  versionId: string
  size: number
  /** epoch ms when this archive was taken */
  archivedAt: number
}

/** Version id for a file's current bytes (same value CheckFileInfo reports). */
export function versionIdOf(st: { mtimeMs: number }): string {
  return String(Math.round(st.mtimeMs))
}

/** Serialize async work per key (used to make archive+write atomic per file). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const run = prev.then(fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return run
  }
}

export class VersionStore {
  private readonly dataDir: string
  private readonly cap: number

  constructor(dataDir: string, cap: number) {
    this.dataDir = dataDir
    this.cap = cap
  }

  private dirFor(fileId: string): string {
    return join(this.dataDir, '.versions', fileId)
  }

  /** Archive the current bytes of `p` (if any) before they are overwritten. */
  async archiveBeforeWrite(fileId: string, p: string): Promise<void> {
    // cap <= 0 is the production "latest only" mode: do not create an
    // archive directory or retain prior document bytes.
    if (this.cap <= 0) return
    let st
    try {
      st = await stat(p)
    } catch {
      return // nothing to archive (first write)
    }
    const dir = this.dirFor(fileId)
    await mkdir(dir, { recursive: true })
    await copyFile(p, join(dir, versionIdOf(st)))
    await this.prune(fileId)
  }

  /** Newest-first list of archived versions (excludes the live file itself). */
  async list(fileId: string): Promise<VersionInfo[]> {
    const dir = this.dirFor(fileId)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const out: VersionInfo[] = []
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue
      try {
        const st = await stat(join(dir, name))
        if (st.isFile()) out.push({ versionId: name, size: st.size, archivedAt: Math.round(st.mtimeMs) })
      } catch {
        // vanished between readdir and stat — skip
      }
    }
    out.sort((a, b) => Number(b.versionId) - Number(a.versionId))
    return out
  }

  private async prune(fileId: string): Promise<void> {
    const versions = await this.list(fileId)
    const excess = versions.slice(this.cap)
    const dir = this.dirFor(fileId)
    await Promise.all(excess.map((v) => rm(join(dir, v.versionId), { force: true })))
  }
}
