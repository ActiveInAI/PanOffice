import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { startTestServer, wopiUrl } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()))
})

async function put(base: string, body: string, file = 'a.docx'): Promise<Response> {
  return fetch(wopiUrl(base, `/wopi/files/${file}/contents`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('version archiving', () => {
  it('archives the previous bytes on every PutFile', async () => {
    const srv = await startTestServer()
    cleanups.push(srv.close)

    let res = await put(srv.base, 'second-generation')
    expect(res.status).toBe(200)
    const archiveDir = join(srv.dataDir, '.versions', 'a.docx')
    let archives = await readdir(archiveDir)
    expect(archives).toHaveLength(1)
    expect(await readFile(join(archiveDir, archives[0]), 'utf8')).toBe('original-a-bytes')

    await sleep(15) // distinct mtime -> distinct version id
    res = await put(srv.base, 'third-generation')
    expect(res.status).toBe(200)
    archives = await readdir(archiveDir)
    expect(archives).toHaveLength(2)
    const contents = await Promise.all(archives.map((a) => readFile(join(archiveDir, a), 'utf8')))
    expect(contents.sort()).toEqual(['original-a-bytes', 'second-generation'])

    // live file holds the newest bytes
    expect(await readFile(join(srv.dataDir, 'a.docx'), 'utf8')).toBe('third-generation')
  })

  it('prunes to the version cap, keeping the newest archives', async () => {
    const srv = await startTestServer({ versionCap: 10 })
    cleanups.push(srv.close)
    for (let i = 1; i <= 12; i++) {
      await sleep(5)
      const res = await put(srv.base, `generation-${String(i).padStart(2, '0')}`)
      expect(res.status).toBe(200)
    }
    const archiveDir = join(srv.dataDir, '.versions', 'a.docx')
    const archives = await readdir(archiveDir)
    expect(archives).toHaveLength(10)
    const contents = (
      await Promise.all(archives.map((a) => readFile(join(archiveDir, a), 'utf8')))
    ).sort()
    // archives hold the *previous* body of each put: mtime₀→original,
    // mtime₁→gen-01, …, mtime₁₁→gen-11; pruning the 2 oldest ids drops
    // 'original-a-bytes' and 'generation-01', leaving gen-02..gen-11.
    expect(contents).toEqual(
      Array.from({ length: 10 }, (_, i) => `generation-${String(i + 2).padStart(2, '0')}`).sort(),
    )
  })

  it('lists versions via GET /wopi/files/:id/versions and reports currentVersion coherently', async () => {
    const srv = await startTestServer()
    cleanups.push(srv.close)

    // no archives yet: empty list, currentVersion == CheckFileInfo Version
    let res = await fetch(wopiUrl(srv.base, '/wopi/files/a.docx/versions'))
    expect(res.status).toBe(200)
    let body = (await res.json()) as { currentVersion: string; versions: unknown[] }
    const cfi = (await (
      await fetch(wopiUrl(srv.base, '/wopi/files/a.docx'))
    ).json()) as { Version: string; CurrentVersion: string }
    expect(body.versions).toEqual([])
    expect(body.currentVersion).toBe(cfi.Version)
    expect(cfi.CurrentVersion).toBe(cfi.Version)

    await sleep(15)
    await put(srv.base, 'v2')
    res = await fetch(wopiUrl(srv.base, '/wopi/files/a.docx/versions'))
    body = (await res.json()) as {
      currentVersion: string
      versions: Array<{ versionId: string; size: number; archivedAt: number }>
    }
    expect(body.versions).toHaveLength(1)
    expect(body.versions[0].versionId).toMatch(/^\d+$/)
    expect(body.versions[0].versionId).toBe(cfi.Version) // the archived id is the previous live id
    expect(body.versions[0].size).toBe('original-a-bytes'.length)
    expect(body.currentVersion).not.toBe(cfi.Version) // live file moved on

    // archived ids are excluded from the directory listing on the dev index
    const index = await (await fetch(`${srv.base}/`)).text()
    expect(index).not.toContain('.versions')
  })

  it('answers X-WOPI-ItemVersion on PutFile and GetFile', async () => {
    const srv = await startTestServer()
    cleanups.push(srv.close)

    const getRes = await fetch(wopiUrl(srv.base, '/wopi/files/a.docx/contents'))
    expect(getRes.status).toBe(200)
    const before = getRes.headers.get('X-WOPI-ItemVersion')
    expect(before).toMatch(/^\d+$/)

    await sleep(15)
    const putRes = await put(srv.base, 'newer-bytes')
    const after = putRes.headers.get('X-WOPI-ItemVersion')
    expect(after).toMatch(/^\d+$/)
    expect(after).not.toBe(before)

    // and CheckFileInfo agrees with the PutFile-reported version
    const cfi = (await (
      await fetch(wopiUrl(srv.base, '/wopi/files/a.docx'))
    ).json()) as { Version: string }
    expect(cfi.Version).toBe(after)
  })

  it('requires auth and an existing file for the versions endpoint', async () => {
    const srv = await startTestServer()
    cleanups.push(srv.close)
    expect((await fetch(`${srv.base}/wopi/files/a.docx/versions`)).status).toBe(401)
    expect((await fetch(wopiUrl(srv.base, '/wopi/files/nope.docx/versions'))).status).toBe(404)
  })
})
