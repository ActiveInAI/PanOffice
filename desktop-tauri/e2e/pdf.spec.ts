import { expect, test } from '@playwright/test'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib'

/**
 * M2 acceptance: open the fixture pdf through the ported editor, add a note
 * annotation via the real UI (toolbar Note tool → page click → modal), save
 * with Ctrl+S, reload, and prove the edit persisted.
 *
 * The app mounts no annotation layer, so a saved note is not visible in the
 * DOM after reload — persistence is asserted on the bytes instead: the saved
 * file comes back out of the browser byte-store (IndexedDB overlay) through
 * window.pdfApi.readFile and is parsed with pdf-lib here in Node.
 */

const FIXTURE = '/fixtures/hello.pdf'
const NOTE_TEXT = 'E2E note from the Tauri port'

test('open, annotate, save, reload — note persists in the file bytes', async ({ page }) => {
  await page.goto(`/#/pdf?src=${FIXTURE}`)

  // Text layer up → document loaded and rendered
  const textLayer = page.locator('.textLayer').first()
  await expect(textLayer).toContainText('Hello PanOffice', { timeout: 30_000 })

  // One edit through the real UI: Note tool → click on page 1 → type → OK
  await page.getByRole('button', { name: '便签', exact: true }).click()
  await page.locator('.pdf-draw-layer').first().click({ position: { x: 220, y: 220 } })
  const textarea = page.locator('.pdf-modal-textarea')
  await expect(textarea).toBeVisible()
  await textarea.fill(NOTE_TEXT)
  await page.locator('.pdf-modal-btn.primary').click()

  // Unsaved note shows as a pin on the page; save button becomes enabled
  await expect(page.locator('.pdf-note-pin')).toHaveCount(1)
  await page.keyboard.press('Control+s')

  // save() persists first, then reloads the doc from the saved bytes, which
  // clears the unsaved overlays — the pin disappearing is the deterministic
  // "save cycle finished" signal (the text layer alone would match stale DOM).
  await expect(page.locator('.pdf-note-pin')).toHaveCount(0)
  await expect(textLayer).toContainText('Hello PanOffice', { timeout: 30_000 })

  // Full page reload: the editor must reopen from persisted state (IDB overlay)
  await page.reload()
  await expect(page.locator('.textLayer').first()).toContainText('Hello PanOffice', {
    timeout: 30_000,
  })

  // Byte-level proof: read the saved file back through the bridge and parse it
  const b64 = await page.evaluate(async (path) => {
    const buf = await window.pdfApi.readFile(path)
    const bytes = new Uint8Array(buf)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return btoa(bin)
  }, FIXTURE)
  const doc = await PDFDocument.load(Buffer.from(b64, 'base64'))
  expect(doc.getPageCount()).toBe(2)
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
})
