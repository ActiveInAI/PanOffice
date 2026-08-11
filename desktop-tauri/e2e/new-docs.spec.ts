import { expect, test } from '@playwright/test'

/**
 * The "new document" cards on the home generate a minimal blank file and
 * open the matching editor. We assert the editor chrome comes up (blank
 * pages legitimately have no text content to wait for).
 */
test('new-docx card opens the docs editor on a generated blank document', async ({ page }) => {
  await page.goto('/#/')
  await page.getByTestId('new-docx').click()
  await expect(page).toHaveURL(/#\/docs\?src=/)
  await expect(page.locator('body')).toBeVisible()
  // docs editor toolbar proves the app booted with the generated file
  await expect(page.getByRole('button', { name: '保存 (⌘S)' })).toBeVisible({ timeout: 30_000 })
})

test('new-pdf card opens the pdf editor on a generated blank document', async ({ page }) => {
  await page.goto('/#/')
  await page.getByTestId('new-pdf').click()
  await expect(page).toHaveURL(/#\/pdf\?src=/)
  // pdf editor: draw layer of the single blank page
  await expect(page.locator('.pdf-draw-layer').first()).toBeVisible({ timeout: 30_000 })
})

test('new-pdf card resets a previously consumed PDF source and restores the full toolbar', async ({
  page,
}) => {
  await page.goto(`/#/pdf?src=${encodeURIComponent('/fixtures/hello.pdf')}`)
  await expect(page.locator('.textLayer').first()).toContainText('Hello PanOffice', {
    timeout: 30_000,
  })

  // Returning home by hash keeps the bridge module alive, matching the user
  // flow that previously left consumePending() in its consumed state.
  await page.evaluate(() => {
    window.location.hash = '#/'
  })
  await expect(page.getByTestId('new-pdf')).toBeVisible()
  await page.getByTestId('new-pdf').click()

  await expect(page).toHaveURL(/#\/pdf\?src=/)
  await expect(page.getByTestId('panai-toggle')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.pdf-draw-layer').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('没有要打开的文件', { exact: true })).toHaveCount(0)
})

test('new-xlsx card opens the sheets editor on a generated blank workbook', async ({ page }) => {
  await page.goto('/#/')
  await page.getByTestId('new-xlsx').click()
  await expect(page).toHaveURL(/#\/sheets\?src=/)
  // univer renders into a canvas; the formula bar input is a stable DOM signal
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
})
