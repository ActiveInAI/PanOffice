import { chromium } from '@playwright/test'
const url = 'http://127.0.0.1:3210/edit/simple.docx'
const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
try {
  let frame
  for (let i = 0; i < 60 && !frame; i++) {
    await page.waitForTimeout(1000)
    frame = page.frames().find((f) => f.url().includes('cool.html'))
  }
  if (!frame) throw new Error('cool.html frame never appeared; frames=' + page.frames().map((f) => f.url()).join(','))
  console.log('FRAME_URL', frame.url().slice(0, 120))
  await frame.waitForSelector('canvas', { timeout: 60_000 })
  await page.waitForTimeout(6000)
  const state = await frame.evaluate(() => ({
    canvases: document.querySelectorAll('canvas').length,
    text: (document.body?.innerText || '').slice(0, 300),
  }))
  console.log('FRAME_STATE', JSON.stringify(state))
  console.log('RESULT OK')
} catch (e) {
  console.log('RESULT FAIL', String(e).slice(0, 400))
}
if (errors.length) console.log('PAGE_ERRORS', errors.slice(0, 3).join(' | '))
await browser.close()
