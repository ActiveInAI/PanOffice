/**
 * Generates public/fixtures/hello.pdf — the headless-test fixture document.
 * Two US-Letter pages with real text in a standard font so the pdf.js text
 * layer has something to find ("Hello PanOffice page 1/2").
 *
 * Run: npm run fixture:pdf
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const outPath = join(rootDir, 'public', 'fixtures', 'hello.pdf')

const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
for (const n of [1, 2]) {
  const page = doc.addPage([612, 792])
  page.drawText(`Hello PanOffice page ${n}`, {
    x: 72,
    y: 700,
    size: 24,
    font,
    color: rgb(0, 0, 0),
  })
  page.drawText('Fixture document for the PanOffice Tauri port (M2).', {
    x: 72,
    y: 660,
    size: 12,
    font,
    color: rgb(0.2, 0.2, 0.2),
  })
}
await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, await doc.save({ useObjectStreams: false }))
console.log(`wrote ${outPath}`)
