import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ArchiveEntry } from '../../src/apps/sheets/gateway/xlsx-package-io'
import { createNodeHostIo } from '../../src/apps/sheets/gateway/host-io-node'
import { assertManifestPreserved, saveWorkbookViaSidecar } from '../../src/apps/sheets/gateway/xlsx-package-io'
import { XlsxSidecarClient } from '../../src/apps/sheets/sidecar/xlsx-sidecar-client'
import { buildEditFixture } from './fixture-builder'

describe('saveWorkbookViaSidecar', () => {
  let directory: string
  let client: XlsxSidecarClient

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'xlsx-streaming-save-'))
    client = new XlsxSidecarClient(sidecarBinaryPath())
  })

  afterAll(async () => {
    client.stop()
    await rm(directory, { recursive: true, force: true })
  })

  it('saves a cell edit while raw-copying every untouched entry byte-for-byte', async () => {
    const sourcePath = join(directory, 'source.xlsx')
    const targetPath = join(directory, 'saved.xlsx')
    const sourceBuffer = await buildEditFixture()
    await writeFile(sourcePath, sourceBuffer)

    const result = await saveWorkbookViaSidecar({
      client,
      io: createNodeHostIo(),
      sourcePath,
      targetPath,
      edits: [
        {
          sheetName: 'Data',
          row: 0,
          column: 0,
          writeValue: true,
          cell: { value: 'World' },
        },
      ],
    })

    expect(result.touchedEntries).toEqual(['xl/workbook.xml', 'xl/worksheets/sheet1.xml'])
    expect(result.removedEntries).toEqual([])
    expect(result.addedEntries).toEqual([])

    const sourceZip = await JSZip.loadAsync(sourceBuffer)
    const savedZip = await JSZip.loadAsync(await readFile(targetPath))
    expect(Object.keys(savedZip.files).sort()).toEqual(Object.keys(sourceZip.files).sort())

    const savedSheet = await savedZip.file('xl/worksheets/sheet1.xml')?.async('text')
    expect(savedSheet).toContain('<is><t xml:space="preserve">World</t></is>')
    const savedWorkbook = await savedZip.file('xl/workbook.xml')?.async('text')
    expect(savedWorkbook).toContain('fullCalcOnLoad="1"')

    for (const path of Object.keys(sourceZip.files)) {
      if (sourceZip.files[path]?.dir) continue
      if (path === 'xl/worksheets/sheet1.xml' || path === 'xl/workbook.xml') continue
      const [sourceBytes, savedBytes] = await Promise.all([
        sourceZip.file(path)?.async('uint8array'),
        savedZip.file(path)?.async('uint8array'),
      ])
      expect(savedBytes).toEqual(sourceBytes)
    }
  })

  it('reopens its own output: a second edit chains on the saved file', async () => {
    const firstPath = join(directory, 'chain-1.xlsx')
    const secondPath = join(directory, 'chain-2.xlsx')
    await writeFile(firstPath, await buildEditFixture())

    await saveWorkbookViaSidecar({
      client,
      io: createNodeHostIo(),
      sourcePath: firstPath,
      targetPath: secondPath,
      edits: [{ sheetName: 'Data', row: 4, column: 0, writeValue: true, cell: { value: 41 } }],
    })
    await saveWorkbookViaSidecar({
      client,
      io: createNodeHostIo(),
      sourcePath: secondPath,
      targetPath: secondPath,
      edits: [{ sheetName: 'Data', row: 5, column: 0, writeValue: true, cell: { value: 42 } }],
    })

    const savedZip = await JSZip.loadAsync(await readFile(secondPath))
    const sheet = await savedZip.file('xl/worksheets/sheet1.xml')?.async('text')
    expect(sheet).toContain('<c r="A5"><v>41</v></c>')
    expect(sheet).toContain('<c r="A6"><v>42</v></c>')
  })
})

describe('assertManifestPreserved', () => {
  const entry = (name: string, crc32 = 1, size = 10): ArchiveEntry => ({
    name,
    crc32,
    compressedSize: size,
    uncompressedSize: size,
  })
  const plan = (
    replaced: string[] = [],
    added: string[] = [],
    removedEntries: string[] = [],
  ): Parameters<typeof assertManifestPreserved>[0] => ({
    replaced: new Map(replaced.map((name) => [name, ''])),
    added: new Map(added.map((name) => [name, ''])),
    removedEntries,
  })

  it('accepts identical untouched entries and declared changes', () => {
    expect(() =>
      assertManifestPreserved(
        plan(['b.xml'], ['c.xml'], ['d.xml']),
        [entry('a.xml'), entry('b.xml'), entry('d.xml')],
        [entry('a.xml'), entry('b.xml', 99, 12), entry('c.xml', 7)],
      ),
    ).not.toThrow()
  })

  it('rejects an undeclared content change', () => {
    expect(() => assertManifestPreserved(plan(), [entry('a.xml', 1)], [entry('a.xml', 2)])).toThrow(
      'unexpectedly modify a.xml',
    )
  })

  it('rejects dropped, surviving-despite-removal, and surprise entries', () => {
    expect(() => assertManifestPreserved(plan(), [entry('a.xml')], [])).toThrow('drop a.xml')
    expect(() =>
      assertManifestPreserved(plan([], [], ['a.xml']), [entry('a.xml')], [entry('a.xml')]),
    ).toThrow('should have removed a.xml')
    expect(() =>
      assertManifestPreserved(plan(), [entry('a.xml')], [entry('a.xml'), entry('extra.xml')]),
    ).toThrow('unexpectedly create extra.xml')
  })

  it('rejects a missing declared addition', () => {
    expect(() =>
      assertManifestPreserved(plan([], ['new.xml']), [entry('a.xml')], [entry('a.xml')]),
    ).toThrow('should have created new.xml')
  })
})

function sidecarBinaryPath(): string {
  if (process.env.XLSX_SIDECAR_PATH) return process.env.XLSX_SIDECAR_PATH
  const executable = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  // vitest runs with cwd = desktop-tauri (import.meta.url is unreliable under
  // the vite module runner)
  return resolve(process.cwd(), 'native', 'xlsx-engine', 'target', 'release', executable)
}
