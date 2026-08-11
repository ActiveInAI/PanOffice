import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfigFromEnv, parseDevTokens, parsePermissionSpec } from '../src/config.js'
import { startFakeDiscovery, startTestServer } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()))
})

describe('config parsing', () => {
  it('parses WOPI_TOKENS_JSON into dev token entries', () => {
    const tokens = parseDevTokens(
      '{"tok-a":{"userId":"a","name":"A","permissions":"read"},"tok-b":{"userId":"b","name":"B","permissions":{"*":"read","x.docx":"read-write"}}}',
    )
    expect(tokens['tok-a']).toEqual({ userId: 'a', name: 'A', permissions: 'read' })
    expect(tokens['tok-b'].permissions).toEqual({ '*': 'read', 'x.docx': 'read-write' })
  })

  it('fills defaults for sparse entries and rejects garbage', () => {
    expect(parseDevTokens('{"t":{}}')['t']).toEqual({
      userId: 'dev-user',
      name: 'Dev User',
      permissions: 'read-write',
    })
    expect(() => parseDevTokens('{oops')).toThrow(/WOPI_TOKENS_JSON/)
    expect(() => parseDevTokens('[1,2]')).toThrow(/WOPI_TOKENS_JSON/)
    expect(parseDevTokens(undefined)).toEqual({})
  })

  it('parsePermissionSpec keeps valid levels and drops junk', () => {
    expect(parsePermissionSpec('read')).toBe('read')
    expect(parsePermissionSpec('read-write')).toBe('read-write')
    expect(parsePermissionSpec('bogus')).toBe('read-write') // dev-friendly default
    expect(parsePermissionSpec({ '*': 'read', f: 'nope' as never })).toEqual({ '*': 'read' })
    expect(parsePermissionSpec(null)).toBe('read-write')
  })

  it('loadConfigFromEnv applies defaults and overrides', () => {
    const cfg = loadConfigFromEnv({})
    expect(cfg.port).toBe(3000)
    expect(cfg.allowDevToken).toBe(false)
    expect(cfg.sharedToken).toBeNull()
    expect(cfg.xlsxRpcUrl).toBeNull()
    expect(cfg.panAiBridgeUrl).toBeNull()
    expect(cfg.panAiBridgeToken).toBeNull()
    expect(cfg.panAiModel).toBe('gpt-5.6-sol')
    expect(cfg.proofRequired).toBe(false)
    expect(cfg.lockTtlMs).toBe(30 * 60 * 1000)
    expect(cfg.versionCap).toBe(10)

    const custom = loadConfigFromEnv({
      PORT: '3210',
      WOPI_ALLOW_DEV_TOKEN: 'true',
      WOPI_PROOF_REQUIRED: '1',
      WOPI_LOCK_TTL_MINUTES: '5',
      WOPI_VERSION_CAP: '3',
      COLLABORA_INTERNAL_URL: 'http://127.0.0.1:9982/',
      XLSX_RPC_URL: 'http://127.0.0.1:8791/rpc/',
      PANAI_BRIDGE_URL: 'http://127.0.0.1:8790/v1/',
      PANAI_MODEL: 'claude-sonnet-5-max',
    })
    expect(custom.port).toBe(3210)
    expect(custom.allowDevToken).toBe(true)
    expect(custom.proofRequired).toBe(true)
    expect(custom.lockTtlMs).toBe(300_000)
    expect(custom.versionCap).toBe(3)
    expect(custom.collaboraInternalUrl).toBe('http://127.0.0.1:9982') // trailing slash stripped
    expect(custom.collaboraPublicUrl).toBe('http://127.0.0.1:9982') // falls back to internal
    expect(custom.xlsxRpcUrl).toBe('http://127.0.0.1:8791/rpc')
    expect(custom.panAiBridgeUrl).toBe('http://127.0.0.1:8790/v1')
    expect(custom.panAiModel).toBe('claude-sonnet-5-max')
    expect(() => loadConfigFromEnv({ XLSX_RPC_URL: 'https://example.com/rpc' })).toThrow(
      /loopback/,
    )
    expect(() => loadConfigFromEnv({ PANAI_BRIDGE_URL: 'http://example.com/v1' })).toThrow(
      /loopback/,
    )
    expect(() => loadConfigFromEnv({ PANAI_MODEL: 'bad model' })).toThrow(/PANAI_MODEL/)
  })

  it('loads the production shared token from an absolute owner-managed file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'panoffice-token-'))
    const tokenFile = join(dir, 'token')
    const token = 'a'.repeat(64)
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
    expect(loadConfigFromEnv({ WOPI_SHARED_TOKEN_FILE: tokenFile }).sharedToken).toBe(token)
  })

  it('loads the PanAI bridge token without exposing it to the web shell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'panai-bridge-token-'))
    const tokenFile = join(dir, 'token')
    const token = 'b'.repeat(64)
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
    expect(loadConfigFromEnv({ PANAI_BRIDGE_TOKEN_FILE: tokenFile }).panAiBridgeToken).toBe(token)
  })
})

describe('dev UI', () => {
  it('is fail-closed when production disables development surfaces', async () => {
    const srv = await startTestServer({ devUiEnabled: false })
    cleanups.push(srv.close)

    expect((await fetch(`${srv.base}/files.json`)).status).toBe(404)
    expect((await fetch(`${srv.base}/upload?name=x.docx`, { method: 'POST', body: 'x' })).status).toBe(404)
    expect((await fetch(`${srv.base}/edit/a.docx`)).status).toBe(404)
  })

  it('index page lists files and edit links', async () => {
    const srv = await startTestServer({}, { 'a.docx': 'x', 'notes.bin': 'y' })
    cleanups.push(srv.close)
    const html = await (await fetch(`${srv.base}/`)).text()
    expect(html).toContain('a.docx')
    expect(html).toContain('/edit/a.docx')
    expect(html).toContain('notes.bin')
    expect(html).not.toContain('/edit/notes.bin') // not an office extension
  })

  it('index page offers our editors for docx/xlsx/pptx, Collabora as the collab option', async () => {
    const srv = await startTestServer(
      {},
      { 'a.docx': 'x', 'b.xlsx': 'y', 'c.pptx': 'z', 'notes.bin': 'w' },
    )
    cleanups.push(srv.close)
    const html = await (await fetch(`${srv.base}/`)).text()
    expect(html).toContain('PanOffice 编辑器')
    // each office format routes to its shell app with a tokened WOPI src
    for (const [file, app] of [
      ['a.docx', 'docs'],
      ['b.xlsx', 'sheets'],
      ['c.pptx', 'slides'],
    ] as const) {
      expect(html).toContain(`http://shell.test/#/${app}?src=`)
      expect(html).toContain(`/wopi/files/${file}/contents?access_token={T}`)
    }
    // Collabora stays as the collaboration option, and non-office files get neither
    expect(html).toContain('/edit/a.docx')
    expect(html).not.toContain('/edit/notes.bin')
    const binRow = html.split('\n').find((l) => l.includes('notes.bin'))
    expect(binRow).toBeTruthy()
    expect(binRow).not.toContain('edit-link')
  })

  it('shows a token chooser when multiple dev tokens are configured', async () => {
    const srv = await startTestServer({
      devTokens: { 'tok-alice': { userId: 'alice', name: 'Alice', permissions: 'read-write' } },
    })
    cleanups.push(srv.close)
    const html = await (await fetch(`${srv.base}/`)).text()
    expect(html).toContain('token-chooser')
    expect(html).toContain('Dev User (shared devtoken)')
    expect(html).toContain('Alice (alice)')
  })

  it('omits the chooser with a single token and hides dotfiles', async () => {
    const srv = await startTestServer({ allowDevToken: true })
    cleanups.push(srv.close)
    // create a lock so .wopi-locks.json exists, then confirm it stays hidden
    await fetch(`${srv.base}/wopi/files/a.docx?access_token=devtoken`, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'LOCK', 'X-WOPI-Lock': 'L1' },
    })
    const html = await (await fetch(`${srv.base}/`)).text()
    // no chooser element (the upload script may still reference the id by name)
    expect(html).not.toContain('id="token-chooser"')
    expect(html).not.toContain('.wopi-locks.json')
  })

  it('edit page embeds the selected token and the WOPISrc', async () => {
    // point at a fake discovery so /edit resolves a urlsrc
    const discovery = await startFakeDiscovery(
      '<wopi-discovery><net-zone name="external-http"><app name="writer">' +
        '<action ext="docx" name="edit" urlsrc="http://collabora.test/browser/abc/cool.html?"/>' +
        '</app></net-zone></wopi-discovery>',
    )
    cleanups.push(discovery.close)
    const srv = await startTestServer({
      collaboraInternalUrl: discovery.url,
      collaboraPublicUrl: 'http://collabora-public.test',
      devTokens: { 'tok-alice': { userId: 'alice', name: 'Alice', permissions: 'read' } },
    })
    cleanups.push(srv.close)

    let html = await (await fetch(`${srv.base}/edit/a.docx`)).text()
    expect(html).toContain('access_token=devtoken') // default: first choice (shared dev token)
    expect(html).toContain(encodeURIComponent(`${srv.cfg.wopiPublicBase}/wopi/files/a.docx`))
    expect(html).toContain('http://collabora-public.test/browser/abc/cool.html')

    html = await (await fetch(`${srv.base}/edit/a.docx?token=tok-alice`)).text()
    expect(html).toContain('access_token=tok-alice')
  })
})
