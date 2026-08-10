// PanOffice branding proof shots: branded Collabora UI served by coolwsd :9982
// through the wopi-host edit page on :3210.
// Usage: node tools/brand-shot.mjs   (from desktop-tauri/)
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const OUT = new URL('../../docs/screenshots/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.setDefaultTimeout(60_000)

await page.goto('http://127.0.0.1:3210/edit/simple.docx', { waitUntil: 'domcontentloaded' })

let frame
for (let i = 0; i < 60 && !frame; i++) {
  await page.waitForTimeout(1000)
  frame = page.frames().find((f) => f.url().includes('cool.html'))
}
if (!frame) throw new Error('cool.html frame never appeared')

await frame.waitForSelector('canvas', { timeout: 60_000 })
await page.waitForTimeout(5000) // let tiles + header settle

// (a) editor with the PanOffice star in the document header
await page.screenshot({ path: OUT + 'collabora-edit-panoffice.png' })
console.log('saved collabora-edit-panoffice.png')

// (b) About dialog: PanOffice product name + star logo
// (show() clones the hidden #about-dialog template into a visible #about-dialog-box modal)
await frame.evaluate(() => window.app.map.showLOAboutDialog())
await frame.waitForSelector('#about-dialog-box', { state: 'visible', timeout: 15_000 })
await page.waitForTimeout(1200) // version info fills in async
const productName = await frame.evaluate(
  () => document.querySelector('#about-dialog-box #product-name')?.innerText,
)
console.log('about product-name =', JSON.stringify(productName))
await page.screenshot({ path: OUT + 'collabora-about-panoffice.png' })
console.log('saved collabora-about-panoffice.png')

await browser.close()
console.log('BRAND SHOTS OK')
