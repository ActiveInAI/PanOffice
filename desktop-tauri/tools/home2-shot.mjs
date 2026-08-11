import { chromium } from '@playwright/test'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
await page.goto('http://localhost:4180/#/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)
await page.screenshot({ path: '../docs/screenshots/shell-home-unified.png' })
console.log('saved')
await browser.close()
