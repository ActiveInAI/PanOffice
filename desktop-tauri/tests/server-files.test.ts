import { describe, expect, it } from 'vitest'
import { resolveFilesBase, resolveServerContentUrl } from '../src/server-files'

describe('resolveFilesBase', () => {
  it('uses the deployed shell origin for a remote web page', () => {
    expect(resolveFilesBase(null, 'http://192.168.1.100:3210/')).toBe(
      'http://192.168.1.100:3210',
    )
  })

  it('ignores a stale localhost override on a remote web page', () => {
    expect(
      resolveFilesBase('http://127.0.0.1:3210/', 'http://192.168.1.100:3210/#/'),
    ).toBe('http://192.168.1.100:3210')
  })

  it('preserves an explicit remote file-service override', () => {
    expect(
      resolveFilesBase('https://files.example.test/base/', 'https://office.example.test/'),
    ).toBe('https://files.example.test/base')
  })

  it('uses the same-origin proxy for local Vite and ignores a stale 3210 override', () => {
    expect(resolveFilesBase(null, 'http://127.0.0.1:5190/')).toBe('http://127.0.0.1:5190')
    expect(
      resolveFilesBase('http://127.0.0.1:3210/', 'http://127.0.0.1:5190/'),
    ).toBe('http://127.0.0.1:5190')
  })

  it('keeps the local 3210 service for native Tauri', () => {
    expect(resolveFilesBase(null, 'tauri://localhost/', true)).toBe('http://127.0.0.1:3210')
  })
})

describe('resolveServerContentUrl', () => {
  it('routes deployment content through the current web file-service origin', () => {
    expect(
      resolveServerContentUrl(
        'http://192.168.1.100:3210/wopi/files/a.docx/contents?access_token=test',
        'http://127.0.0.1:5190',
      ),
    ).toBe('http://127.0.0.1:5190/wopi/files/a.docx/contents?access_token=test')
  })

  it('retains the deployment content URL for native Tauri', () => {
    const contentUrl = 'http://192.168.1.100:3210/wopi/files/a.docx/contents?access_token=test'
    expect(resolveServerContentUrl(contentUrl, 'http://127.0.0.1:3210', true)).toBe(
      contentUrl,
    )
  })
})
