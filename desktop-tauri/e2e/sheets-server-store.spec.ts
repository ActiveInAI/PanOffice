import { expect, test } from '@playwright/test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import JSZip from 'jszip'

/**
 * Regression for the "opens as a silent blank grid" bug: a `local/<name>`
 * workbook source must resolve against the server file store when this
 * browser holds no IndexedDB copy (fresh device, wiped profile, another
 * machine's URL). The copy is planted server-side only; every Playwright
 * test gets a fresh storage-empty context, which is exactly the failing
 * scenario. And when the bytes exist nowhere, the editor must say so in a
 * dialog instead of leaving the default empty workbook on screen.
 */

const NAME = 'cross-device-regression.xlsx'
/** Data dir of the wopi-host answering on :3210 — the playwright-spawned one
 * by default; override when reusing an already-running host (its store). */
const STORE_DIR = process.env.PANOFFICE_E2E_STORE_DIR ?? '../deploy/data/files'
const STORE_PATH = `${STORE_DIR}/${NAME}`
const SHEET = '服务器数据'

/** hello.xlsx with its sheet renamed — the tab text proves the grid content
 * came from the server store, not from a blank fallback workbook. */
async function makeMarkedWorkbook(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(readFileSync('public/fixtures/hello.xlsx'))
  const workbook = await zip.file('xl/workbook.xml')!.async('string')
  zip.file('xl/workbook.xml', workbook.replace(/name="[^"]+"/, `name="${SHEET}"`))
  return zip.generateAsync({ type: 'nodebuffer' })
}

test.beforeAll(async () => {
  writeFileSync(STORE_PATH, await makeMarkedWorkbook())
})

test.afterAll(() => {
  rmSync(STORE_PATH, { force: true })
})

test('local/ workbook src opens from the server store in a fresh browser', async ({ page }) => {
  await page.goto(`/#/sheets?src=${encodeURIComponent(`local/${NAME}`)}`)
  await expect(page.getByText(SHEET, { exact: true })).toBeVisible({ timeout: 45_000 })
})

test('workbook missing from store and browser raises a visible dialog', async ({ page }) => {
  const dialogs: string[] = []
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message())
    void dialog.accept()
  })
  await page.goto(`/#/sheets?src=${encodeURIComponent('local/missing-nowhere.xlsx')}`)
  await expect
    .poll(() => dialogs.join('\n'), { timeout: 30_000 })
    .toContain('无法打开工作簿')
})
