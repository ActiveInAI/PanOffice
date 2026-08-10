import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

describe('dev upload endpoint', () => {
  let srv: TestServer
  beforeEach(async () => {
    srv = await startTestServer({}, {})
  })
  afterEach(async () => {
    await srv.close()
  })

  it('stores raw bytes under the given name and the file becomes readable', async () => {
    const payload = Buffer.from('uploaded-bytes-%PDF-fake')
    const res = await fetch(`${srv.base}/upload?name=${encodeURIComponent('new file.pdf')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: payload,
    })
    expect(res.status).toBe(201)
    expect((await res.json()).name).toBe('new file.pdf')
    const onDisk = await readFile(join(srv.dataDir, 'new file.pdf'))
    expect(onDisk.equals(payload)).toBe(true)
    // and it is then served back over WOPI GetFile
    const getRes = await fetch(
      `${srv.base}/wopi/files/${encodeURIComponent('new file.pdf')}/contents?access_token=devtoken`,
    )
    expect(getRes.status).toBe(200)
    expect(Buffer.from(await getRes.arrayBuffer()).equals(payload)).toBe(true)
  })

  it('rejects path traversal in the name', async () => {
    const res = await fetch(`${srv.base}/upload?name=${encodeURIComponent('../evil.txt')}`, {
      method: 'POST',
      body: 'x',
    })
    expect(res.status).toBe(400)
  })

  it('index page links pdf files to the PanOffice editor with a tokened src', async () => {
    await fetch(`${srv.base}/upload?name=doc.pdf`, { method: 'POST', body: Buffer.from('%PDF') })
    const html = await (await fetch(`${srv.base}/`)).text()
    expect(html).toContain('edit in PanOffice PDF')
    // the raw src template (token substituted client-side by the chooser)
    expect(html).toContain('/wopi/files/doc.pdf/contents?access_token={T}')
    // and the default-token href already points at the shell
    expect(html).toContain('http://shell.test/#/pdf?src=')
  })
})
