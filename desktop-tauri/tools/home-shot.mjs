import { chromium } from '@playwright/test'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto('http://127.0.0.1:4180/#/', { waitUntil: 'networkidle', timeout: 30_000 }).catch(async () => {
  // preview server may not be running; start one
})
await page.waitForTimeout(1500)
await page.screenshot({ path: '../docs/screenshots/tauri-shell-home.png' })
console.log('shot saved')
await browser.close()
