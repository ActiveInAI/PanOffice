import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

describe('GET /files.json (shell file-manager listing)', () => {
  let srv: TestServer
  beforeEach(async () => {
    srv = await startTestServer(
      {},
      { 'a.docx': 'docx-bytes', 'b.xlsx': 'xlsx-bytes!!', '.hidden': 'secret' },
    )
    // internal artifacts that must stay hidden from the listing
    await mkdir(join(srv.dataDir, '.versions'), { recursive: true })
    await writeFile(join(srv.dataDir, '.wopi-locks.json'), '{}')
    await mkdir(join(srv.dataDir, 'subdir'), { recursive: true })
  })
  afterEach(async () => {
    await srv.close()
  })

  it('lists visible files with name/size/mtimeMs, skipping dotfiles and dirs', async () => {
    const res = await fetch(`${srv.base}/files.json`)
    expect(res.status).toBe(200)
    const list = (await res.json()) as {
      name: string
      size: number
      mtimeMs: number
      contentUrl?: string
    }[]
    expect(list.map((f) => f.name)).toEqual(['a.docx', 'b.xlsx'])
    expect(list[0]!.size).toBe('docx-bytes'.length)
    expect(typeof list[0]!.mtimeMs).toBe('number')
    expect(list[0]!.mtimeMs).toBeGreaterThan(0)
    const contentUrl = new URL(list[0]!.contentUrl!)
    expect(contentUrl.pathname).toBe('/wopi/files/a.docx/contents')
    expect(contentUrl.searchParams.get('access_token')).toBe('devtoken')
  })

  it('uses the configured token instead of assuming the frontend default', async () => {
    await srv.close()
    srv = await startTestServer({ devToken: 'deployment-specific-token' }, { 'a.docx': 'x' })
    const list = (await (await fetch(`${srv.base}/files.json`)).json()) as {
      contentUrl?: string
    }[]
    expect(new URL(list[0]!.contentUrl!).searchParams.get('access_token')).toBe(
      'deployment-specific-token',
    )
  })

  it('carries the shell CORS origin, including OPTIONS preflights', async () => {
    const res = await fetch(`${srv.base}/files.json`)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://shell.test')
    const pre = await fetch(`${srv.base}/files.json`, { method: 'OPTIONS' })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://shell.test')
    expect(pre.headers.get('access-control-allow-methods')).toContain('DELETE')
  })

  it('upload is CORS-enabled too, and uploaded files appear in the listing', async () => {
    const pre = await fetch(`${srv.base}/upload?name=x.docx`, { method: 'OPTIONS' })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://shell.test')
    const res = await fetch(`${srv.base}/upload?name=x.docx`, { method: 'POST', body: 'zz' })
    expect(res.status).toBe(201)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://shell.test')
    const list = (await (await fetch(`${srv.base}/files.json`)).json()) as { name: string }[]
    expect(list.map((f) => f.name)).toContain('x.docx')
  })

  it('deletes a listed file with the listing token and removes it from the listing', async () => {
    const list = (await (await fetch(`${srv.base}/files.json`)).json()) as {
      name: string
      contentUrl?: string
    }[]
    const file = list.find((entry) => entry.name === 'a.docx')!
    const deleteUrl = new URL(file.contentUrl!)
    deleteUrl.host = new URL(srv.base).host
    deleteUrl.pathname = deleteUrl.pathname.replace(/\/contents$/, '')

    const pre = await fetch(deleteUrl, { method: 'OPTIONS' })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-methods')).toContain('DELETE')

    const removed = await fetch(deleteUrl, { method: 'DELETE' })
    expect(removed.status).toBe(204)
    expect((await fetch(deleteUrl)).status).toBe(404)
    const after = (await (await fetch(`${srv.base}/files.json`)).json()) as { name: string }[]
    expect(after.map((entry) => entry.name)).toEqual(['b.xlsx'])
  })

  it('does not expose hidden files or nested paths to DELETE', async () => {
    await writeFile(join(srv.dataDir, 'subdir', 'child.docx'), 'child')
    const hidden = await fetch(`${srv.base}/wopi/files/.hidden?access_token=devtoken`, {
      method: 'DELETE',
    })
    expect(hidden.status).toBe(404)
    const nested = await fetch(
      `${srv.base}/wopi/files/subdir%2Fchild.docx?access_token=devtoken`,
      { method: 'DELETE' },
    )
    expect(nested.status).toBe(404)
  })

  it('keeps a locked file until its WOPI lock is released', async () => {
    const fileUrl = `${srv.base}/wopi/files/a.docx?access_token=devtoken`
    expect((await fetch(fileUrl, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'LOCK', 'X-WOPI-Lock': 'editor-lock' },
    })).status).toBe(200)

    const blocked = await fetch(fileUrl, { method: 'DELETE' })
    expect(blocked.status).toBe(409)
    expect(blocked.headers.get('x-wopi-lock')).toBe('editor-lock')
    expect((await fetch(fileUrl)).status).toBe(200)

    expect((await fetch(fileUrl, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'UNLOCK', 'X-WOPI-Lock': 'editor-lock' },
    })).status).toBe(200)
    expect((await fetch(fileUrl, { method: 'DELETE' })).status).toBe(204)
  })
})
