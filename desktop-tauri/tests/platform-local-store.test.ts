import { describe, expect, it } from 'vitest'
import { listedContentUrl, serverIdForLocalKey } from '../src/bridge/platform'
import { wopiDisplayName } from '../src/server-files'

describe('serverIdForLocalKey', () => {
  it('maps local/ document keys onto flat store ids', () => {
    expect(serverIdForLocalKey('local/报表 2026.xlsx')).toBe('报表 2026.xlsx')
    expect(serverIdForLocalKey('local/hello.pdf')).toBe('hello.pdf')
  })

  it('leaves every non-document key alone', () => {
    expect(serverIdForLocalKey('sheets-attachments/pasted.png')).toBeNull()
    expect(serverIdForLocalKey('__sheets_recovery__/local/报表.xlsx')).toBeNull()
    expect(serverIdForLocalKey('未命名.xlsx')).toBeNull()
  })

  it('rejects names the store itself rejects', () => {
    expect(serverIdForLocalKey('local/')).toBeNull()
    expect(serverIdForLocalKey('local/.wopi-locks.json')).toBeNull()
    expect(serverIdForLocalKey('local/nested/name.xlsx')).toBeNull()
    expect(serverIdForLocalKey('local/back\\slash.xlsx')).toBeNull()
  })
})

describe('listedContentUrl', () => {
  const listing = [
    {
      name: '报表.xlsx',
      contentUrl:
        'http://192.168.1.100:3210/wopi/files/%E6%8A%A5%E8%A1%A8.xlsx/contents?access_token=tok',
    },
    { name: 'no-url.xlsx' },
  ]

  it('rebases the deployment URL onto the shell origin', () => {
    expect(listedContentUrl('报表.xlsx', listing, 'https://panoffice.ko.tw.cn')).toBe(
      'https://panoffice.ko.tw.cn/wopi/files/%E6%8A%A5%E8%A1%A8.xlsx/contents?access_token=tok',
    )
  })

  it('returns null for unlisted files, missing URLs and no listing', () => {
    expect(listedContentUrl('other.xlsx', listing, 'http://127.0.0.1:3210')).toBeNull()
    expect(listedContentUrl('no-url.xlsx', listing, 'http://127.0.0.1:3210')).toBeNull()
    expect(listedContentUrl('报表.xlsx', null, 'http://127.0.0.1:3210')).toBeNull()
  })
})

describe('wopiDisplayName', () => {
  it('decodes the file id of a WOPI contents URL', () => {
    expect(
      wopiDisplayName(
        'https://panoffice.ko.tw.cn/wopi/files/%E8%AF%AD%E4%B9%89%E5%AD%97%E5%85%B8.xlsx/contents?access_token=tok',
      ),
    ).toBe('语义字典.xlsx')
    expect(wopiDisplayName('http://127.0.0.1:3210/wopi/files/hello.xlsx/contents')).toBe(
      'hello.xlsx',
    )
  })

  it('returns null for every non-WOPI path', () => {
    expect(wopiDisplayName('local/报表.xlsx')).toBeNull()
    expect(wopiDisplayName('/fixtures/hello.pdf')).toBeNull()
    expect(wopiDisplayName('https://example.test/wopi/files/x.xlsx')).toBeNull()
  })
})
