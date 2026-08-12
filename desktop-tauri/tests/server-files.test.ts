import { describe, expect, it } from 'vitest'
import {
  resolveFilesBase,
  resolveServerContentUrl,
  resolveServerDeleteUrl,
} from '../src/server-files'

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

describe('resolveServerDeleteUrl', () => {
  it('uses the authorized listing URL and routes it through the current web origin', () => {
    expect(
      resolveServerDeleteUrl(
        'a.docx',
        'http://192.168.1.100:3210/wopi/files/a.docx/contents?access_token=deployment-token',
        'https://panoffice.example.test',
        'wrong-fallback',
      ),
    ).toBe(
      'https://panoffice.example.test/wopi/files/a.docx?access_token=deployment-token',
    )
  })

  it('keeps the deployment origin for native Tauri', () => {
    expect(
      resolveServerDeleteUrl(
        'a.docx',
        'http://192.168.1.100:3210/wopi/files/a.docx/contents?access_token=deployment-token',
        'http://127.0.0.1:3210',
        'wrong-fallback',
        true,
      ),
    ).toBe(
      'http://192.168.1.100:3210/wopi/files/a.docx?access_token=deployment-token',
    )
  })

  it('builds a tokened fallback when the listing has no usable contents URL', () => {
    expect(
      resolveServerDeleteUrl(
        '工程 计划.xlsx',
        undefined,
        'http://127.0.0.1:5190/',
        'dev token',
      ),
    ).toBe(
      'http://127.0.0.1:5190/wopi/files/%E5%B7%A5%E7%A8%8B%20%E8%AE%A1%E5%88%92.xlsx?access_token=dev%20token',
    )
  })
})
