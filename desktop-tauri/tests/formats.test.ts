import { describe, expect, it } from 'vitest'
import {
  FULL_TOOLBAR_EXTS,
  OFFICE_FILE_ACCEPT,
  OFFICE_ROUTES,
  SERVER_EDITED_ROUTES,
  officeHref,
  ofdPdfExportUrl,
} from '../src/open-office-file'

describe('format routing', () => {
  it('maps every supported format to an editor', () => {
    expect(OFFICE_ROUTES).toEqual({
      docx: 'docs',
      xlsx: 'sheets',
      pptx: 'slides',
      pdf: 'pdf',
      odt: 'collabora',
      ods: 'collabora',
      odp: 'collabora',
      doc: 'collabora',
      xls: 'collabora',
      ppt: 'collabora',
      rtf: 'collabora',
      csv: 'collabora',
      txt: 'text',
      xml: 'text',
      ofd: 'ofd',
    })
  })

  it('offers every routed format in the file picker', () => {
    const accepted = new Set(OFFICE_FILE_ACCEPT.split(',').map((entry) => entry.replace('.', '')))
    for (const ext of Object.keys(OFFICE_ROUTES)) {
      expect(accepted.has(ext), `${ext} is offered by the picker`).toBe(true)
    }
  })

  it('requires the store for server-side editors only', () => {
    expect([...SERVER_EDITED_ROUTES].sort()).toEqual(['collabora', 'ofd', 'sheets'])
  })
})

describe('officeHref', () => {
  it('routes ordinary formats to their own editor', () => {
    expect(officeHref('collabora', 'http://host.test:3210/wopi/files/a.odt/contents?access_token=t')).toBe(
      `#/collabora?src=${encodeURIComponent('http://host.test:3210/wopi/files/a.odt/contents?access_token=t')}`,
    )
    expect(officeHref('text', 'local/notes.txt')).toBe(`#/text?src=${encodeURIComponent('local/notes.txt')}`)
  })

  it('keeps OFD on its own source: the viewer renders the container natively', () => {
    const src = 'http://host.test:3210/wopi/files/%E5%8F%91%E7%A5%A8.ofd/contents?access_token=t'
    expect(officeHref('ofd', src)).toBe(`#/ofd?src=${encodeURIComponent(src)}`)
  })

  it('still exposes the server-rendered PDF twin for export', () => {
    expect(
      ofdPdfExportUrl('http://host.test:3210/wopi/files/%E5%8F%91%E7%A5%A8.ofd/contents?access_token=t'),
    ).toBe('http://host.test:3210/ofd/%E5%8F%91%E7%A5%A8.ofd/pdf')
    expect(ofdPdfExportUrl('http://host.test:3210/wopi/files/a.docx/contents')).toBeNull()
  })
})

describe('full-toolbar alternative', () => {
  it('covers the editable formats and skips fixed-layout ones', () => {
    for (const ext of ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'doc', 'rtf', 'txt']) {
      expect(FULL_TOOLBAR_EXTS.has(ext), `${ext} offers the Collabora toolbar`).toBe(true)
    }
    for (const ext of ['pdf', 'ofd', 'xml']) {
      expect(FULL_TOOLBAR_EXTS.has(ext), `${ext} has no Collabora editor`).toBe(false)
    }
  })
})
