import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LockManager } from '../src/locks.js'
import { startTestServer, wopiUrl } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()))
})

async function lockOp(
  base: string,
  override: string,
  lockHeader?: string,
  token = 'devtoken',
): Promise<Response> {
  const headers: Record<string, string> = { 'X-WOPI-Override': override }
  if (lockHeader !== undefined) headers['X-WOPI-Lock'] = lockHeader
  return fetch(wopiUrl(base, '/wopi/files/a.docx', token), { method: 'POST', headers })
}

async function put(base: string, body: string, lockHeader?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' }
  if (lockHeader !== undefined) headers['X-WOPI-Lock'] = lockHeader
  return fetch(wopiUrl(base, '/wopi/files/a.docx/contents'), { method: 'POST', headers, body })
}

describe('LockManager (unit)', () => {
  async function makeManager(ttlMs = 60_000): Promise<{ mgr: LockManager; file: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'wopi-locks-unit-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const file = join(dir, '.wopi-locks.json')
    return { mgr: await LockManager.load(file, ttlMs), file }
  }

  it('locks an unlocked file', async () => {
    const { mgr } = await makeManager()
    expect(await mgr.lock('a.docx', 'L1')).toEqual({ ok: true })
    expect(mgr.get('a.docx')?.token).toBe('L1')
  })

  it('re-locks idempotently with the same token and refreshes expiry', async () => {
    const { mgr } = await makeManager()
    await mgr.lock('a.docx', 'L1')
    const first = mgr.get('a.docx')!.expiresAt
    await new Promise((r) => setTimeout(r, 5))
    const result = await mgr.lock('a.docx', 'L1')
    expect(result).toEqual({ ok: true })
    expect(mgr.get('a.docx')!.expiresAt).toBeGreaterThanOrEqual(first)
  })

  it('conflicts with the current token on a foreign LOCK', async () => {
    const { mgr } = await makeManager()
    await mgr.lock('a.docx', 'L1')
    const result = await mgr.lock('a.docx', 'L2')
    expect(result).toMatchObject({ ok: false })
    expect((result as { current: { token: string } }).current.token).toBe('L1')
  })

  it('unlock/refresh tri-states: ok, mismatch, not-locked', async () => {
    const { mgr } = await makeManager()
    expect(await mgr.unlock('a.docx', 'L1')).toBe('not-locked')
    expect(await mgr.refresh('a.docx', 'L1')).toBe('not-locked')
    await mgr.lock('a.docx', 'L1')
    expect(await mgr.unlock('a.docx', 'L2')).toBe('mismatch')
    expect(await mgr.refresh('a.docx', 'L2')).toBe('mismatch')
    expect(await mgr.refresh('a.docx', 'L1')).toBe('ok')
    expect(await mgr.unlock('a.docx', 'L1')).toBe('ok')
    expect(mgr.get('a.docx')).toBeNull()
  })

  it('expires locks after the TTL', async () => {
    const { mgr } = await makeManager(40)
    await mgr.lock('a.docx', 'L1')
    expect(mgr.get('a.docx')).not.toBeNull()
    await new Promise((r) => setTimeout(r, 60))
    expect(mgr.get('a.docx')).toBeNull()
    // expired lock no longer conflicts
    expect(await mgr.lock('a.docx', 'L2')).toEqual({ ok: true })
  })

  it('persists locks to disk and reloads them (dropping expired ones)', async () => {
    const { mgr, file } = await makeManager(60_000)
    await mgr.lock('a.docx', 'L1')
    const reloaded = await LockManager.load(file, 60_000)
    expect(reloaded.get('a.docx')?.token).toBe('L1')

    // an entry whose persisted expiry has passed is dropped on load
    const dir = await mkdtemp(join(tmpdir(), 'wopi-locks-unit-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const expiredFile = join(dir, '.wopi-locks.json')
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(expiredFile, JSON.stringify({ 'b.docx': { token: 'OLD', expiresAt: Date.now() - 1000 } })),
    )
    const dropped = await LockManager.load(expiredFile, 60_000)
    expect(dropped.get('b.docx')).toBeNull()
  })

  it('starts empty on a corrupt lock file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wopi-locks-unit-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const file = join(dir, '.wopi-locks.json')
    await import('node:fs/promises').then((fs) => fs.writeFile(file, '{not json'))
    const mgr = await LockManager.load(file, 60_000)
    expect(mgr.get('a.docx')).toBeNull()
  })
})

describe('WOPI lock ops (HTTP)', () => {
  it('full conflict matrix', async () => {
    const srv = await startTestServer()
    cleanups.push(srv.close)
    const base = srv.base

    // GET_LOCK on unlocked file: 200 with empty X-WOPI-Lock
    let res = await lockOp(base, 'GET_LOCK')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-WOPI-Lock')).toBe('')

    // LOCK takes the lock
    res = await lockOp(base, 'LOCK', 'L1')
    expect(res.status).toBe(200)

    // GET_LOCK reports it
    res = await lockOp(base, 'GET_LOCK')
    expect(res.headers.get('X-WOPI-Lock')).toBe('L1')

    // LOCK with the same token is idempotent success
    res = await lockOp(base, 'LOCK', 'L1')
    expect(res.status).toBe(200)

    // LOCK with a foreign token: 409 + current token in X-WOPI-Lock
    res = await lockOp(base, 'LOCK', 'L2')
    expect(res.status).toBe(409)
    expect(res.headers.get('X-WOPI-Lock')).toBe('L1')

    // REFRESH_LOCK with the wrong token: 409; with the right one: 200
    res = await lockOp(base, 'REFRESH_LOCK', 'L2')
    expect(res.status).toBe(409)
    expect(res.headers.get('X-WOPI-Lock')).toBe('L1')
    res = await lockOp(base, 'REFRESH_LOCK', 'L1')
    expect(res.status).toBe(200)

    // UNLOCK with the wrong token: 409; with the right one: 200
    res = await lockOp(base, 'UNLOCK', 'L2')
    expect(res.status).toBe(409)
    res = await lockOp(base, 'UNLOCK', 'L1')
    expect(res.status).toBe(200)

    // now unlocked again
    res = await lockOp(base, 'GET_LOCK')
    expect(res.headers.get('X-WOPI-Lock')).toBe('')

    // UNLOCK / REFRESH_LOCK on an unlocked file: 409 with empty X-WOPI-Lock
    res = await lockOp(base, 'UNLOCK', 'L1')
    expect(res.status).toBe(409)
    expect(res.headers.get('X-WOPI-Lock')).toBe('')
    res = await lockOp(base, 'REFRESH_LOCK', 'L1')
    expect(res.status).toBe(409)
  })

  it('requires X-WOPI-Lock on LOCK/UNLOCK/REFRESH_LOCK', async () => {
    const srv = await startTestServer()
    cleanups.push(srv.close)
    for (const op of ['LOCK', 'UNLOCK', 'REFRESH_LOCK']) {
      const res = await lockOp(srv.base, op)
      expect(res.status).toBe(400)
    }
  })

  it('rejects unknown X-WOPI-Override values with 501', async () => {
    const srv = await startTestServer()
    cleanups.push(srv.close)
    const res = await lockOp(srv.base, 'PUT_RELATIVE', 'L1')
    expect(res.status).toBe(501)
  })

  it('404s lock ops on missing files', async () => {
    const srv = await startTestServer()
    cleanups.push(srv.close)
    const res = await fetch(wopiUrl(srv.base, '/wopi/files/nope.docx'), {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'LOCK', 'X-WOPI-Lock': 'L1' },
    })
    expect(res.status).toBe(404)
  })

  it('PutFile is 409 with X-WOPI-Lock when another token holds the lock', async () => {
    const srv = await startTestServer()
    cleanups.push(srv.close)
    await lockOp(srv.base, 'LOCK', 'L1')

    // no X-WOPI-Lock header at all -> conflict
    let res = await put(srv.base, 'v2')
    expect(res.status).toBe(409)
    expect(res.headers.get('X-WOPI-Lock')).toBe('L1')

    // wrong lock token -> conflict
    res = await put(srv.base, 'v2', 'L2')
    expect(res.status).toBe(409)

    // matching lock token -> saved
    res = await put(srv.base, 'v2', 'L1')
    expect(res.status).toBe(200)

    // after UNLOCK, PutFile is allowed again without a lock header
    await lockOp(srv.base, 'UNLOCK', 'L1')
    res = await put(srv.base, 'v3')
    expect(res.status).toBe(200)
  })

  it('keeps locks across an app restart (persistence file)', async () => {
    const first = await startTestServer()
    const dataDir = first.dataDir
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    await lockOp(first.base, 'LOCK', 'L-PERSIST')
    await first.stop()

    // second instance over the same data dir sees the lock
    const second = await startTestServer({ dataDir }, {})
    cleanups.push(second.stop)
    const res = await lockOp(second.base, 'GET_LOCK')
    expect(res.headers.get('X-WOPI-Lock')).toBe('L-PERSIST')
    const putRes = await put(second.base, 'v2')
    expect(putRes.status).toBe(409)
  })
})
