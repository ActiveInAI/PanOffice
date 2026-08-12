import { expect, test } from '@playwright/test'

test('opening Excel from Home stays in the SPA and loads the workbook', async ({ page }) => {
  let documentRequests = 0
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests += 1
  })

  await page.route('**/files.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  )
  await page.goto('/#/')

  await page.getByText('新建表格', { exact: true }).click()

  await expect(page).toHaveURL(/#\/sheets\?src=/)
  await expect(page.getByText('Sheet1', { exact: true })).toBeVisible()
  expect(documentRequests).toBe(1)
})
