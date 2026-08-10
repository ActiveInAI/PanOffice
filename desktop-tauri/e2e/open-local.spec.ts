import { expect, test } from '@playwright/test'

/**
 * "Open local file" from the shell home: the picker hands the bytes to the
 * platform store and routes to the editor matching the extension.
 */
test('home open-local routes a pdf to the pdf editor', async ({ page }) => {
  await page.goto('/#/')
  await page.locator('input[type="file"]').setInputFiles('public/fixtures/hello.pdf')
  await expect(page).toHaveURL(/#\/pdf\?src=local%2Fhello\.pdf/)
  await expect(page.locator('.textLayer').first()).toContainText('Hello PanOffice', {
    timeout: 30_000,
  })
})

test('home open-local routes a docx to the docs editor', async ({ page }) => {
  await page.goto('/#/')
  await page.locator('input[type="file"]').setInputFiles('public/fixtures/simple.docx')
  await expect(page).toHaveURL(/#\/docs\?src=local%2Fsimple\.docx/)
  // docs canvas renders the fixture's paragraphs
  await expect(page.locator('body')).toContainText('第二段', { timeout: 30_000 })
})
