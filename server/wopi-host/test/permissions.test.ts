import { afterAll, describe, expect, it } from 'vitest'
import { startTestServer, wopiUrl } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()))
})

const TOKENS = {
  'tok-rw': { userId: 'rw-user', name: 'ReadWrite', permissions: 'read-write' as const },
  'tok-ro': { userId: 'ro-user', name: 'ReadOnly', permissions: 'read' as const },
  'tok-mixed': {
    userId: 'mixed-user',
    name: 'Mixed',
    permissions: { '*': 'read' as const, 'a.docx': 'read-write' as const },
  },
}

async function setup() {
  const srv = await startTestServer(
    { allowDevToken: false, devTokens: TOKENS },
    { 'a.docx': 'aaa', 'b.docx': 'bbb' },
  )
  cleanups.push(srv.close)
  return srv
}

const lockHeaders = { 'X-WOPI-Override': 'LOCK', 'X-WOPI-Lock': 'L1' }

describe('permission enforcement', () => {
  it('read-write token: UserCanWrite true, can PutFile and LOCK', async () => {
    const srv = await setup()
    const cfi = (await (
      await fetch(wopiUrl(srv.base, '/wopi/files/a.docx', 'tok-rw'))
    ).json()) as { UserCanWrite: boolean; UserId: string }
    expect(cfi.UserCanWrite).toBe(true)
    expect(cfi.UserId).toBe('rw-user')

    const put = await fetch(wopiUrl(srv.base, '/wopi/files/a.docx/contents', 'tok-rw'), {
      method: 'POST',
      body: 'new',
    })
    expect(put.status).toBe(200)

    const lock = await fetch(wopiUrl(srv.base, '/wopi/files/a.docx', 'tok-rw'), {
      method: 'POST',
      headers: lockHeaders,
    })
    expect(lock.status).toBe(200)
  })

  it('read-only token: UserCanWrite false; PutFile/LOCK/UNLOCK/REFRESH_LOCK 403; reads allowed', async () => {
    const srv = await setup()
    const cfiRes = await fetch(wopiUrl(srv.base, '/wopi/files/a.docx', 'tok-ro'))
    expect(cfiRes.status).toBe(200)
    const cfi = (await cfiRes.json()) as { UserCanWrite: boolean }
    expect(cfi.UserCanWrite).toBe(false)

    // reads still work
    expect((await fetch(wopiUrl(srv.base, '/wopi/files/a.docx/contents', 'tok-ro'))).status).toBe(200)
    expect((await fetch(wopiUrl(srv.base, '/wopi/files/a.docx/versions', 'tok-ro'))).status).toBe(200)
    const getLock = await fetch(wopiUrl(srv.base, '/wopi/files/a.docx', 'tok-ro'), {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'GET_LOCK' },
    })
    expect(getLock.status).toBe(200)

    // writes are forbidden
    const put = await fetch(wopiUrl(srv.base, '/wopi/files/a.docx/contents', 'tok-ro'), {
      method: 'POST',
      body: 'nope',
    })
    expect(put.status).toBe(403)
    for (const op of ['LOCK', 'UNLOCK', 'REFRESH_LOCK']) {
      const res = await fetch(wopiUrl(srv.base, '/wopi/files/a.docx', 'tok-ro'), {
        method: 'POST',
        headers: { 'X-WOPI-Override': op, 'X-WOPI-Lock': 'L1' },
      })
      expect(res.status).toBe(403)
    }
  })

  it('per-file map: write on the listed file, read-only elsewhere', async () => {
    const srv = await setup()
    const aCfi = (await (
      await fetch(wopiUrl(srv.base, '/wopi/files/a.docx', 'tok-mixed'))
    ).json()) as { UserCanWrite: boolean }
    const bCfi = (await (
      await fetch(wopiUrl(srv.base, '/wopi/files/b.docx', 'tok-mixed'))
    ).json()) as { UserCanWrite: boolean }
    expect(aCfi.UserCanWrite).toBe(true)
    expect(bCfi.UserCanWrite).toBe(false)

    const putA = await fetch(wopiUrl(srv.base, '/wopi/files/a.docx/contents', 'tok-mixed'), {
      method: 'POST',
      body: 'ok',
    })
    expect(putA.status).toBe(200)
    const putB = await fetch(wopiUrl(srv.base, '/wopi/files/b.docx/contents', 'tok-mixed'), {
      method: 'POST',
      body: 'nope',
    })
    expect(putB.status).toBe(403)
  })

  it('read-only PutFile leaves the file and its version archive untouched', async () => {
    const srv = await setup()
    await fetch(wopiUrl(srv.base, '/wopi/files/a.docx/contents', 'tok-ro'), {
      method: 'POST',
      body: 'nope',
    })
    const body = await (await fetch(wopiUrl(srv.base, '/wopi/files/a.docx/contents', 'tok-rw'))).text()
    expect(body).toBe('aaa')
    const versions = (await (
      await fetch(wopiUrl(srv.base, '/wopi/files/a.docx/versions', 'tok-rw'))
    ).json()) as { versions: unknown[] }
    expect(versions.versions).toEqual([])
  })
})
