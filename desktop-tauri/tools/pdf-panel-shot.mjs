import { chromium } from '@playwright/test'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
await page.goto('http://localhost:4180/#/pdf?src=/fixtures/hello.pdf', { waitUntil: 'domcontentloaded' })
await page.locator('.textLayer').first().waitFor({ timeout: 30_000 })
// ensure the AI panel is OPEN: if only the rail is visible, click it to expand
const rail = page.locator('.ai-rail')
if (await rail.count()) await rail.first().click()
await page.locator('.ai-panel-header').waitFor({ timeout: 10_000 })
await page.waitForTimeout(800)
await page.screenshot({ path: '../docs/screenshots/pdf-ai-panel-right.png' })
console.log('shot saved')
await browser.close()
