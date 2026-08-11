import { expect, test } from '@playwright/test'
import { copyFileSync, readFileSync } from 'node:fs'
import JSZip from 'jszip'

/**
 * Web-side docs editing acceptance: the PanOffice docs editor (Tauri frontend
 * served on :4180) opens simple.docx straight from the wopi-host (:3210) over
 * HTTP, edits through the real UI, and the save lands back on the server's
 * disk via a WOPI PutFile-style POST — no IndexedDB shadowing involved.
 *
 * Byte-level proof reads the on-disk file, bypassing the app entirely.
 */

const FILE = 'simple.docx'
const SERVER_FILE = `../deploy/data/files/${FILE}`
const SRC = `http://127.0.0.1:3210/wopi/files/${FILE}/contents?access_token=devtoken`
const MARKER = 'E2E-WEB'

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

test('open docx from wopi-host, edit in browser, save lands on server disk', async ({ page }) => {
  // pristine starting state (and no foreign WOPI lock on the fixture)
  await forceUnlockFixture()
  copyFileSync(`public/fixtures/${FILE}`, SERVER_FILE)

  await page.goto(`/#/docs?src=${encodeURIComponent(SRC)}`)

  // Editor up with the fixture content (标题 / 第一段。 / 第二段。)
  const editor = page.locator('.ProseMirror').first()
  await expect(editor).toContainText('第二段。', { timeout: 30_000 })

  // One edit through the real UI: click into the second paragraph, go to line
  // end, type the marker
  await editor.getByText('第二段。').click()
  await page.keyboard.press('End')
  await page.keyboard.type(MARKER)
  await expect(editor).toContainText(MARKER)

  // Ctrl+S → renderer save pipeline → docx-engine patch → WOPI POST.
  // Completion signal: the localized status bar reports that the file is saved
  // after the save reloaded the editor from the persisted bytes.
  await page.keyboard.press('Control+s')
  await expect(page.locator('.status-msg')).toContainText(/Saved|已保存/, { timeout: 30_000 })
  await expect(editor).toContainText(MARKER, { timeout: 30_000 })

  // proof: the file on the SERVER's disk now carries the edit
  const zip = await JSZip.loadAsync(readFileSync(SERVER_FILE))
  const documentXml = await zip.file('word/document.xml')?.async('string')
  expect(documentXml).toBeTruthy()
  expect(documentXml).toContain(MARKER)
  expect(documentXml).toContain('第二段')

  // reload re-fetches from the server (not any local overlay) and still opens
  await page.reload()
  const editor2 = page.locator('.ProseMirror').first()
  await expect(editor2).toContainText(MARKER, { timeout: 30_000 })
  await expect(editor2).toContainText('标题')

  // restore pristine fixture for the next run
  copyFileSync(`public/fixtures/${FILE}`, SERVER_FILE)
})
