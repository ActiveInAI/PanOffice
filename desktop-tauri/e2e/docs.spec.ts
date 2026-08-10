import { expect, test } from '@playwright/test'
import JSZip from 'jszip'

/**
 * Docs-port acceptance: open the fixture docx through the ported editor, edit
 * via the real UI (click into the last paragraph, type a marker), save with
 * Ctrl+S, reload, and prove the edit persisted.
 *
 * The save pipeline runs the docx-engine paragraph patch in the webview and
 * writes the resulting bytes through window.desktop.saveDocx → the browser
 * byte-store (IndexedDB overlay). Persistence is asserted on the bytes: the
 * saved file comes back through window.desktop.openDocxPath and word/document.xml
 * is unzipped here in Node with jszip (docx-engine's own zip lib).
 */

const FIXTURE = '/fixtures/simple.docx'
const MARKER = 'E2E-EDIT'

test('open, edit, save, reload — marker persists in the docx bytes', async ({ page }) => {
  await page.goto(`/#/docs?src=${FIXTURE}`)

  // Editor up with the fixture content (标题 / 第一段。 / 第二段。)
  const editor = page.locator('.ProseMirror').first()
  await expect(editor).toContainText('第二段。', { timeout: 30_000 })

  // One edit through the real UI: click into the last paragraph, go to line
  // end, type the marker
  await editor.getByText('第二段。').click()
  await page.keyboard.press('End')
  await page.keyboard.type(MARKER)
  await expect(editor).toContainText(MARKER)

  // Ctrl+S → renderer save pipeline → docx-engine patch → bridge write.
  // Completion signal: the status bar shows "Saved" (bridge default lang en)
  // after the save reloaded the editor from the persisted bytes.
  await page.keyboard.press('Control+s')
  await expect(page.locator('.status-msg')).toContainText('Saved', { timeout: 30_000 })
  await expect(editor).toContainText(MARKER, { timeout: 30_000 })

  // Full page reload: the editor must reopen from persisted state (IDB overlay)
  await page.reload()
  const editor2 = page.locator('.ProseMirror').first()
  await expect(editor2).toContainText(MARKER, { timeout: 30_000 })
  await expect(editor2).toContainText('标题')

  // Byte-level proof: read the saved file back through the bridge and unzip it
  const b64 = await page.evaluate(async (path) => {
    const result = await window.desktop.openDocxPath(path)
    if (!result) throw new Error('openDocxPath returned null')
    const bytes = new Uint8Array(result.data)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return btoa(bin)
  }, FIXTURE)
  const zip = await JSZip.loadAsync(Buffer.from(b64, 'base64'))
  const documentXml = await zip.file('word/document.xml')?.async('string')
  expect(documentXml).toBeTruthy()
  expect(documentXml).toContain(MARKER)
  expect(documentXml).toContain('第二段')
})
