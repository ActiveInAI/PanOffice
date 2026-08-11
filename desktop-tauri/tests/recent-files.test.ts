import { describe, expect, it } from 'vitest'
import { removeRecent } from '../src/recent-files'

describe('recent files', () => {
  it('removes only the selected history entry without mutating the input', () => {
    const entries = [
      { key: '/tmp/a.pdf', name: 'a.pdf', ext: 'pdf', ts: 1 },
      { key: '/tmp/b.xlsx', name: 'b.xlsx', ext: 'xlsx', ts: 2 },
    ]

    expect(removeRecent(entries, '/tmp/a.pdf')).toEqual([entries[1]])
    expect(entries).toHaveLength(2)
  })

  it('leaves the list unchanged when the key is unknown', () => {
    const entries = [{ key: '/tmp/a.pdf', name: 'a.pdf', ext: 'pdf', ts: 1 }]
    expect(removeRecent(entries, '/tmp/missing.pdf')).toEqual(entries)
  })
})
