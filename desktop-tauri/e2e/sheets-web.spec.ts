import { expect, test, type Page } from '@playwright/test'
import { copyFileSync, readFileSync } from 'node:fs'
import JSZip from 'jszip'

/**
 * Web-side sheets editing acceptance: the PanOffice sheets editor (Tauri
 * frontend on :4180) opens hello.xlsx straight from the wopi-host (:3210)
 * over HTTP — the bytes are staged for the xlsx sidecar (host.stage), the
 * edit runs through the real UI, and the save POSTs back to the server
 * (PutFile-style) instead of the IndexedDB overlay.
 *
 * Byte-level proof polls the on-disk file, bypassing the app entirely. The
 * grid is canvas-rendered, so cell content is asserted on canvas pixels like
 * in e2e/sheets.spec.ts (same fixture, same cell bands).
 */

const FILE = 'hello.xlsx'
const SERVER_FILE = `../deploy/data/files/${FILE}`
const SRC = `http://127.0.0.1:3210/wopi/files/${FILE}/contents?access_token=devtoken`
const MARKER = 'E2E-WEB'

test.setTimeout(90_000)

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
  try {
    return await page.evaluate(
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
          if (
            data[i + 3]! > 200 &&
            data[i]! < 120 &&
            data[i + 1]! < 120 &&
            data[i + 2]! < 120
          ) {
            dark++
          }
        }
        return dark
      },
      [x, y, w, h] as const,
    )
  } catch (error) {
    if (error instanceof Error && error.message.includes('Execution context was destroyed')) return -1
    throw error
  }
}

/**
 * Cell bands in canvas coordinates (default zoom, origin view): 44px row
 * header, 88px default columns, 26px column header. B1's band starts at
 * x=160: A1's "Hello PanOffice" overflows into empty B1 as far as x≈156.
 */
const A1 = { x: 48, y: 26, w: 84, h: 14 }
const B1 = { x: 160, y: 26, w: 56, h: 14 }

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

/** Unzip the server-disk workbook and return the text-carrying parts */
async function serverSheetHaystack(): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(SERVER_FILE))
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml')?.async('string')
  const sharedStrings = await zip.file('xl/sharedStrings.xml')?.async('string')
  return `${sheetXml ?? ''}\n${sharedStrings ?? ''}`
}

test('File menu opens the workbook selected in the browser picker', async ({ page }) => {
  await page.goto('/#/sheets')
  await page.locator('.ribbon-tab-file').click()

  const chooserPromise = page.waitForEvent('filechooser')
  await page.locator('.file-menu [role="menuitem"]').first().click()
  const chooser = await chooserPromise
  await chooser.setFiles('public/fixtures/hello.xlsx')

  // This proves the selected file replaced the blank workbook: hello.xlsx has
  // visible text in A1, while its B1 is empty.
  await expectCellText(page, A1, 50)
  expect(await gridDarkPixels(page, B1.x, B1.y, B1.w, B1.h)).toBe(0)
})

test('open xlsx from wopi-host, edit in browser, save lands on server disk', async ({ page }) => {
  // pristine starting state (and no foreign WOPI lock on the fixture)
  await forceUnlockFixture()
  copyFileSync(`public/fixtures/${FILE}`, SERVER_FILE)

  await page.goto(`/#/sheets?src=${encodeURIComponent(SRC)}`)

  // "Hello PanOffice" (A1) renders in the Univer grid; B1 starts empty.
  // Readiness is polled on canvas pixels (the status bar's messages race).
  await expectCellText(page, A1, 50)
  expect(await gridDarkPixels(page, B1.x, B1.y, B1.w, B1.h)).toBe(0)

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
  // POST. Completion signal: the saved bytes land on the SERVER's disk (the
  // wopi-host writes via temp+rename, so every poll reads a whole zip).
  await page.locator('.ribbon-tabs .qa-btn').first().click()
  await expect
    .poll(async () => (await serverSheetHaystack()).includes(MARKER), { timeout: 60_000 })
    .toBe(true)
  // Let the renderer finish its post-save reload before we bounce the page.
  await page.waitForTimeout(2_000)

  // Byte-level proof on the server-disk file
  const haystack = await serverSheetHaystack()
  expect(haystack).toContain(MARKER)
  expect(haystack).toContain('Hello PanOffice')
  const zip = await JSZip.loadAsync(readFileSync(SERVER_FILE))
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml')?.async('string')
  expect(sheetXml).toContain('<c r="B1"')

  // reload re-fetches from the server (not any local overlay) and keeps both cells
  await page.reload()
  await expectCellText(page, A1, 50)
  await expectCellText(page, B1, 30)

  // restore pristine fixture for the next run
  copyFileSync(`public/fixtures/${FILE}`, SERVER_FILE)
})
