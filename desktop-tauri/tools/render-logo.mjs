import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
const svg = readFileSync(process.env.HOME + '/panspace/panoffice/branding/logo-mark.svg', 'utf8')
const size = Number(process.argv[2] || 512)
const out = process.argv[3]
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: size, height: size } })
await page.setContent(`<body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`)
await page.locator('svg').screenshot({ path: out, omitBackground: true })
await browser.close()
console.log('rendered', out)
