import { expect, test } from '@playwright/test'

/**
 * Browser-side contract for the formats that gained editors: txt/xml in the
 * built-in text editor. The Collabora (odt/ods/odp/doc/ppt/rtf) and OFD paths
 * need coolwsd and the conversion venv, which this harness does not start;
 * they are verified against the running deployments instead. Routing-table
 * assertions live in tests/formats.test.ts.
 */

test('text editor opens a txt source from the shell route', async ({ page }) => {
  await page.route('**/local/notes.txt', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '第一行\n第二行' }),
  )
  await page.goto(`/#/text?src=${encodeURIComponent('local/notes.txt')}`)
  await expect(page.getByTestId('text-editor')).toHaveValue('第一行\n第二行', { timeout: 30_000 })
  // untouched document: saving is not offered
  await expect(page.getByTestId('text-save')).toBeDisabled()
})

test('text editor decodes a legacy GB18030 file and enables saving after an edit', async ({
  page,
}) => {
  // "编码" in GB18030 — invalid UTF-8, so the decoder must fall back
  const gb18030 = Buffer.from([0xb1, 0xe0, 0xc2, 0xeb])
  await page.route('**/local/legacy.txt', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: gb18030 }),
  )
  await page.goto(`/#/text?src=${encodeURIComponent('local/legacy.txt')}`)
  await expect(page.getByTestId('text-editor')).toHaveValue('编码', { timeout: 30_000 })
  await page.getByTestId('text-editor').fill('编码 已修改')
  await expect(page.getByTestId('text-save')).toBeEnabled()
})

test('the server file list offers a full-toolbar entry for editable formats', async ({ page }) => {
  await page.route('**/files.json', (route) =>
    route.fulfill({
      json: [
        { name: 'report.odt', size: 1234, mtimeMs: 1_700_000_000_000 },
        { name: 'scan.pdf', size: 2345, mtimeMs: 1_700_000_000_000 },
      ],
    }),
  )
  await page.goto('/#/')
  await expect(page.getByTestId('server-files')).toContainText('report.odt')
  // odt gets the Collabora entry; pdf (own editor, no Collabora edit) does not
  await expect(page.getByTestId('server-file-full-toolbar')).toHaveCount(1)
})
