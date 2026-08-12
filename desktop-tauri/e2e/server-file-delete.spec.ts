import { expect, test } from '@playwright/test'

test('server-file trash deletes through WOPI and also removes the matching recent entry', async ({
  page,
}) => {
  const name = '待删除测试.docx'
  let deleted = false
  let deleteUrl = ''

  await page.addInitScript((fileName) => {
    localStorage.setItem(
      'panoffice.recents',
      JSON.stringify([
        { key: `server:${fileName}`, name: fileName, ext: 'docx', ts: Date.now() },
      ]),
    )
  }, name)

  await page.route('**/files.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        deleted
          ? []
          : [
              {
                name,
                size: 12,
                mtimeMs: 1_700_000_000_000,
                contentUrl: `http://192.168.1.100:3210/wopi/files/${encodeURIComponent(name)}/contents?access_token=deployment-token`,
              },
            ],
      ),
    })
  })

  await page.route('**/wopi/files/**', async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.continue()
      return
    }
    deleted = true
    deleteUrl = route.request().url()
    await route.fulfill({ status: 204 })
  })

  await page.goto('/#/')
  await expect(page.getByTestId('server-file-delete')).toBeVisible()
  await expect(page.getByTestId('recent-remove')).toHaveCount(1)

  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm')
    expect(dialog.message()).toContain(name)
    await dialog.accept()
  })
  await page.getByTestId('server-file-delete').click()

  await expect.poll(() => deleted).toBe(true)
  expect(deleteUrl).toContain(`/wopi/files/${encodeURIComponent(name)}`)
  expect(deleteUrl).not.toContain('/contents')
  expect(new URL(deleteUrl).searchParams.get('access_token')).toBe('deployment-token')
  await expect(page.getByTestId('server-file-delete')).toHaveCount(0)
  await expect(page.getByTestId('recent-remove')).toHaveCount(0)
})
