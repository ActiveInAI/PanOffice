import { expect, test, type Page } from '@playwright/test'
import JSZip from 'jszip'

/**
 * Sheets-port acceptance: open the fixture xlsx through the ported Univer
 * editor, edit a cell via the real UI (click the grid cell, type, Enter),
 * save via the quick-access Save button, reload, and prove the edit persisted.
 *
 * The save pipeline runs the gateway in the webview against the xlsx sidecar
 * (via tools/xlsx-sidecar-server.mjs) and writes the resulting bytes through
 * the bridge byte-store (IndexedDB overlay). Persistence is asserted on the
 * bytes: the saved file comes back out of the overlay and
 * xl/worksheets/sheet1.xml + xl/sharedStrings.xml are unzipped here in Node
 * with jszip.
 *
 * The grid is canvas-rendered (no DOM text), so cell content is asserted on
 * the canvas pixels: dark-opaque pixels inside a cell's band, with empty
 * bands as controls. The Name Box echo is not used for verification — it lags
 * unpredictably under the headless runner while the canvas tells the truth.
 */

const FIXTURE = '/fixtures/hello.xlsx'
const MARKER = 'E2E-EDIT'

/** Bounding rect of the largest canvas (the Univer grid) in page coordinates */
async function gridCanvasBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas')].sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0]
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  if (!box) throw new Error('grid canvas not found')
  return box
}

/** Count dark opaque pixels in a rect of the grid canvas (canvas coordinates) */
async function gridDarkPixels(
  page: Page,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<number> {
  return page.evaluate(
    ([rx, ry, rw, rh]) => {
      const canvas = [...document.querySelectorAll('canvas')].sort(
        (a, b) => b.width * b.height - a.width * a.height,
      )[0]
      const ctx = canvas?.getContext('2d')
      if (!ctx) return -1
      const data = ctx.getImageData(rx!, ry!, rw!, rh!).data
      let dark = 0
      for (let i = 0; i < data.length; i += 4) {
        // transparent pixels read as black — require opacity first
        if (data[i + 3]! > 200 && data[i]! < 120 && data[i + 1]! < 120 && data[i + 2]! < 120) {
          dark++
        }
      }
      return dark
    },
    [x, y, w, h] as const,
  )
}

/**
 * Cell bands in canvas coordinates (default zoom, origin view): 44px row
 * header, 88px default columns, 26px column header. B1's band starts at
 * x=160: A1's "Hello PanOffice" overflows into empty B1 as far as x≈156.
 */
const A1 = { x: 48, y: 26, w: 84, h: 14 }
const B1 = { x: 160, y: 26, w: 56, h: 14 }
const EMPTY_FAR = { x: 500, y: 200, w: 84, h: 14 }

/** Poll until a band shows text pixels (dark > threshold) */
async function expectCellText(
  page: Page,
  band: { x: number; y: number; w: number; h: number },
  threshold: number,
): Promise<void> {
  await expect
    .poll(() => gridDarkPixels(page, band.x, band.y, band.w, band.h), { timeout: 30_000 })
    .toBeGreaterThan(threshold)
}

/** Read the saved bytes from the bridge byte-store (IndexedDB overlay); null if absent */
async function readOverlayBase64(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async (key) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('panoffice', 1)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('idb open failed'))
    })
    const bytes = await new Promise<Uint8Array | null>((resolve, reject) => {
      const req = db.transaction('files', 'readonly').objectStore('files').get(key)
      req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null)
      req.onerror = () => reject(req.error ?? new Error('idb get failed'))
    })
    if (!bytes) return null
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return btoa(bin)
  }, path)
}

test('open, edit, save, reload — marker persists in the xlsx bytes', async ({ page }) => {
  await page.goto(`/#/sheets?src=${FIXTURE}`)

  // "Hello PanOffice" (A1) renders in the Univer grid; B1 and a far band are
  // empty controls. NOTE: readiness is polled on canvas pixels, not the status
  // bar — the app's "fully loaded" vs "Streaming: N rows available" messages
  // race each other, so the text is not a stable signal.
  await expectCellText(page, A1, 50)
  expect(await gridDarkPixels(page, B1.x, B1.y, B1.w, B1.h)).toBe(0)
  expect(await gridDarkPixels(page, EMPTY_FAR.x, EMPTY_FAR.y, EMPTY_FAR.w, EMPTY_FAR.h)).toBe(0)

  // The canvas keeps initializing after first paint; a short settle plus a
  // warm-up click on the already-active A1 makes the grid take real clicks.
  await page.waitForTimeout(3_000)

  // One edit through the real UI: click B1 in the grid, type, Enter
  const box = await gridCanvasBox(page)
  await page.mouse.click(box.x + 48, box.y + 34)
  await page.waitForTimeout(500)
  await page.mouse.click(box.x + 176, box.y + 33)
  await page.keyboard.type(MARKER)
  await page.keyboard.press('Enter')
  // the marker text renders in B1's band (if the click missed, this fails)
  await expectCellText(page, B1, 30)

  // Quick-access Save → renderer save pipeline → gateway → sidecar → bridge
  // write. The completion signal is the saved bytes landing in the byte-store
  // (the status bar's "Saved …" is transient — the post-save workbook reload
  // overwrites it).
  await page.getByRole('button', { name: /^(Save \(⌘S\)|保存（⌘S）)$/ }).click()
  let b64: string | null = null
  await expect
    .poll(
      async () => {
        b64 = await readOverlayBase64(page, FIXTURE)
        return b64 !== null
      },
      { timeout: 60_000 },
    )
    .toBe(true)
  if (b64 === null) throw new Error('unreachable')
  // Let the renderer finish its post-save reload (the save reopens the
  // workbook from the persisted bytes) before we bounce the page.
  await page.waitForTimeout(2_000)

  // Full page reload: the editor must reopen from persisted state (IDB overlay)
  await page.reload()
  // A1 keeps "Hello PanOffice"; B1 kept the edit — both render in the grid
  await expectCellText(page, A1, 50)
  await expectCellText(page, B1, 30)

  // Byte-level proof: the saved bytes came back out of the bridge byte-store
  // above; unzip them here in Node
  const zip = await JSZip.loadAsync(Buffer.from(b64, 'base64'))
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml')?.async('string')
  const sharedStrings = await zip.file('xl/sharedStrings.xml')?.async('string')
  expect(sheetXml).toBeTruthy()
  // The gateway writes edited strings inline (t="inlineStr"); the original
  // openpyxl fixture used inline strings too, so sheet1.xml carries both.
  // (A sharedStrings-based file would put them there instead.)
  const haystack = `${sheetXml}\n${sharedStrings ?? ''}`
  expect(haystack).toContain(MARKER)
  expect(haystack).toContain('Hello PanOffice')
  expect(sheetXml).toContain('<c r="B1"')
})
