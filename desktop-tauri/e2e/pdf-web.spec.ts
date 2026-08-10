import { expect, test } from '@playwright/test'
import { copyFileSync, readFileSync } from 'node:fs'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib'

/**
 * Web-side PDF editing acceptance: the PanOffice PDF editor (Tauri frontend
 * served on :4180) opens hello.pdf straight from the wopi-host (:3210) over
 * HTTP, edits through the real UI, and the save lands back on the server's
 * disk via a WOPI PutFile-style POST — no IndexedDB shadowing involved.
 *
 * Byte-level proof reads the on-disk file, bypassing the app entirely.
 */

const FILE = 'hello.pdf'
const SERVER_FILE = `../deploy/data/files/${FILE}`
const SRC = `http://127.0.0.1:3210/wopi/files/${FILE}/contents?access_token=devtoken`
const NOTE_TEXT = 'E2E web-edit from the browser'

test('open pdf from wopi-host, annotate in browser, save lands on server disk', async ({ page }) => {
  // pristine starting state
  copyFileSync(`public/fixtures/${FILE}`, SERVER_FILE)

  await page.goto(`/#/pdf?src=${encodeURIComponent(SRC)}`)
  const textLayer = page.locator('.textLayer').first()
  await expect(textLayer).toContainText('Hello PanOffice', { timeout: 30_000 })

  // real-UI edit: Note tool → click page → type → OK
  await page.getByRole('button', { name: 'Note', exact: true }).click()
  await page.locator('.pdf-draw-layer').first().click({ position: { x: 220, y: 220 } })
  const textarea = page.locator('.pdf-modal-textarea')
  await expect(textarea).toBeVisible()
  await textarea.fill(NOTE_TEXT)
  await page.locator('.pdf-modal-btn.primary').click()
  await expect(page.locator('.pdf-note-pin')).toHaveCount(1)

  // save; pin disappearing = the save+reopen cycle finished
  await page.keyboard.press('Control+s')
  await expect(page.locator('.pdf-note-pin')).toHaveCount(0)
  await expect(textLayer).toContainText('Hello PanOffice', { timeout: 30_000 })

  // proof: the file on the SERVER's disk now carries the annotation
  const doc = await PDFDocument.load(readFileSync(SERVER_FILE))
  const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  expect(annots).toBeTruthy()
  const found = Array.from({ length: annots!.size() }, (_, i) => annots!.lookup(i, PDFDict)).some(
    (annot) => {
      const subtype = annot.lookup(PDFName.of('Subtype'), PDFName).decodeText()
      if (subtype !== 'Text') return false
      const contents = annot.lookupMaybe(PDFName.of('Contents'), PDFHexString)
      return contents?.decodeText().includes(NOTE_TEXT) ?? false
    },
  )
  expect(found).toBe(true)

  // reload re-fetches from the server (not any local overlay) and still opens
  await page.reload()
  await expect(page.locator('.textLayer').first()).toContainText('Hello PanOffice', {
    timeout: 30_000,
  })

  // restore pristine fixture for the next run
  copyFileSync(`public/fixtures/${FILE}`, SERVER_FILE)
})
