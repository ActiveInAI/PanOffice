import { expect, test } from '@playwright/test'

/**
 * "Open local file" from the shell home: the picker hands the bytes to the
 * platform store and routes to the editor matching the extension.
 */
test('home open-local routes a pdf to the pdf editor', async ({ page }) => {
  await page.goto('/#/')
  await page.getByTestId('open-local-input').setInputFiles('public/fixtures/hello.pdf')
  await expect(page).toHaveURL(/#\/pdf\?src=[^&]*hello\.pdf/)
  await expect(page.locator('.textLayer').first()).toContainText('Hello PanOffice', {
    timeout: 30_000,
  })
})

test('home open-local routes a docx to the docs editor', async ({ page }) => {
  await page.goto('/#/')
  await page.getByTestId('open-local-input').setInputFiles('public/fixtures/simple.docx')
  await expect(page).toHaveURL(/#\/docs\?src=[^&]*simple\.docx/)
  // docs canvas renders the fixture's paragraphs
  await expect(page.locator('body')).toContainText('第二段', { timeout: 30_000 })
})

test('home server catalog opens a real docx with the deployment token URL', async ({ page }) => {
  await page.route('**/files.json', async (route) => {
    await route.fulfill({
      json: [
        {
          name: 'server.docx',
          size: 12_345,
          mtimeMs: 1_700_000_000_000,
          contentUrl:
            'http://localhost:4180/wopi/files/server.docx/contents?access_token=deployment-specific-token',
        },
      ],
    })
  })
  await page.route('**/wopi/files/server.docx/contents*', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('access_token')).toBe(
      'deployment-specific-token',
    )
    await route.fulfill({
      path: 'public/fixtures/simple.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
  })

  await page.goto('/#/')
  await expect(page.getByTestId('server-files')).toContainText('server.docx')
  await page.getByText('server.docx', { exact: true }).click()
  await expect(page).toHaveURL(/#\/docs\?src=/)
  await expect(page.locator('body')).toContainText('第二段', { timeout: 30_000 })
})
