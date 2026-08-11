import { describe, expect, it } from 'vitest'
import { resolveFilesBase } from '../src/server-files'

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

  it('keeps the local 3210 service for Vite and native Tauri', () => {
    expect(resolveFilesBase(null, 'http://127.0.0.1:5173/')).toBe('http://127.0.0.1:3210')
    expect(resolveFilesBase(null, 'tauri://localhost/', true)).toBe('http://127.0.0.1:3210')
  })
})
