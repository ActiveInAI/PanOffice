import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
const FILE = process.env.HOME + '/panspace/panoffice/deploy/data/files/simple.docx'
const before = readFileSync(FILE)
const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('http://127.0.0.1:3210/edit/simple.docx', { waitUntil: 'domcontentloaded', timeout: 30_000 })
let frame
for (let i = 0; i < 60 && !frame; i++) {
  await page.waitForTimeout(1000)
  frame = page.frames().find((f) => f.url().includes('cool.html'))
}
if (!frame) { console.log('FAIL no frame'); process.exit(1) }
await frame.waitForSelector('canvas', { timeout: 60_000 })
await page.waitForTimeout(4000)
// click into the document area and type a marker
await frame.locator('canvas').first().click({ position: { x: 200, y: 120 } })
await page.waitForTimeout(500)
await page.keyboard.type('PANOFFICE-E2E-SELFBUILT')
await page.waitForTimeout(1000)
await page.keyboard.press('Control+s')
await page.waitForTimeout(6000)
const after = readFileSync(FILE)
console.log('SIZE_BEFORE', before.length, 'SIZE_AFTER', after.length)
console.log('CHANGED', !before.equals(after))
await browser.close()
