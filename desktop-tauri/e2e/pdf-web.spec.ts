import { expect, test } from '@playwright/test'
import { copyFileSync, readFileSync } from 'node:fs'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  StandardFonts,
} from 'pdf-lib'

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

/**
 * A leftover Collabora session may hold a WOPI lock on the fixture, which
 * would (correctly) 409 the save. Force-unlock as the host operator would:
 * the persisted lock token authorizes a proper UNLOCK call.
 */
async function forceUnlockFixture(): Promise<void> {
  let token: string | null = null
  try {
    const locks = JSON.parse(readFileSync('../deploy/data/files/.wopi-locks.json', 'utf8')) as Record<
      string,
      { token?: string }
    >
    token = locks[FILE]?.token ?? null
  } catch {
    return // no lock file → nothing to unlock
  }
  if (!token) return
  await fetch(`http://127.0.0.1:3210/wopi/files/${FILE}?access_token=devtoken`, {
    method: 'POST',
    headers: { 'X-WOPI-Override': 'UNLOCK', 'X-WOPI-Lock': token },
  }).catch(() => undefined)
}

test('open pdf from wopi-host, annotate in browser, save lands on server disk', async ({ page }) => {
  // pristine starting state (and no foreign WOPI lock on the fixture)
  await forceUnlockFixture()
  copyFileSync(`public/fixtures/${FILE}`, SERVER_FILE)

  await page.goto(`/#/pdf?src=${encodeURIComponent(SRC)}`)
  const textLayer = page.locator('.textLayer').first()
  await expect(textLayer).toContainText('Hello PanOffice', { timeout: 30_000 })

  // real-UI edit: Note tool → click page → type → OK
  await page.getByRole('button', { name: '便签', exact: true }).click()
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

test('File > Open replaces a one-page PDF with another one-page PDF', async ({ page }) => {
  const initial = await PDFDocument.create()
  const initialFont = await initial.embedFont(StandardFonts.Helvetica)
  initial.addPage([612, 792]).drawText('Initial one-page PDF', {
    x: 72,
    y: 700,
    size: 24,
    font: initialFont,
  })
  const initialBytes = Buffer.from(await initial.save())
  const replacement = await PDFDocument.create()
  const font = await replacement.embedFont(StandardFonts.Helvetica)
  replacement.addPage([612, 792]).drawText('Opened through File menu', {
    x: 72,
    y: 700,
    size: 24,
    font,
  })

  await page.route('**/fixtures/open-initial.pdf', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: initialBytes,
    }),
  )
  await page.goto(`/#/pdf?src=${encodeURIComponent('/fixtures/open-initial.pdf')}`)
  await expect(page.locator('.textLayer').first()).toContainText('Initial one-page PDF', {
    timeout: 30_000,
  })

  await page.locator('.ribbon-tab-file').click()
  const chooserPromise = page.waitForEvent('filechooser')
  await page.locator('.file-menu [role="menuitem"]').first().click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'replacement.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await replacement.save()),
  })

  await expect(page.getByText('replacement.pdf', { exact: true })).toBeVisible()
  await expect(page.locator('.textLayer').first()).toContainText('Opened through File menu', {
    timeout: 30_000,
  })
  await expect(page.locator('.textLayer').first()).not.toContainText('Initial one-page PDF')
})
