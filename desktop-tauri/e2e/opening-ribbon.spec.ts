import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

test('PDF retains its complete ribbon while a slow document is opening', async ({ page }) => {
  const pdf = readFileSync('public/fixtures/hello.pdf')
  await page.route('**/slow-opening.pdf', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf })
  })

  await page.goto(`/#/pdf?src=${encodeURIComponent('/slow-opening.pdf')}`)

  const ribbon = page.getByTestId('pdf-opening-ribbon')
  await expect(ribbon).toBeVisible()
  await expect(ribbon.locator('.ribbon-body')).toBeVisible()
  await expect(ribbon.getByRole('button', { name: '文件' })).toBeVisible()
  await expect(ribbon.getByRole('button', { name: '缩略图' })).toBeDisabled()
  await expect(page.locator('.textLayer').first()).toContainText('Hello PanOffice', { timeout: 30_000 })
})

test('switching Word, PowerPoint and PDF files stays in the same document request', async ({ page }) => {
  let documentRequests = 0
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests += 1
  })

  await page.goto('/#/docs')
  await expect(page.getByTestId('panai-toggle')).toBeVisible({ timeout: 30_000 })

  async function openFromMenu(fixture: string): Promise<void> {
    await page.locator('.ribbon-tab-file').click()
    const chooserPromise = page.waitForEvent('filechooser')
    await page.locator('.file-tab-wrap > .file-menu > button:first-child').click()
    const chooser = await chooserPromise
    await chooser.setFiles(fixture)
  }

  await openFromMenu('public/fixtures/hello.pptx')
  await expect(page).toHaveURL(/#\/slides\?src=[^&]*hello\.pptx/)
  await expect(page.getByTestId('panai-toggle')).toBeVisible({ timeout: 30_000 })

  await openFromMenu('public/fixtures/hello.pdf')
  await expect(page).toHaveURL(/#\/pdf\?src=[^&]*hello\.pdf/)
  await expect(page.locator('.textLayer').first()).toContainText('Hello PanOffice', { timeout: 30_000 })

  expect(documentRequests).toBe(1)
})
