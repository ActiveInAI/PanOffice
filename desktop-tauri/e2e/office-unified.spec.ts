import { expect, test, type Page } from '@playwright/test'

test.setTimeout(120_000)

const APPS = [
  {
    name: 'Word',
    url: '/#/docs',
    toggle: 'panai-toggle',
    sheet: false,
    theme: 'rgb(24, 90, 189)',
    emptyCopy: '让PanAI帮你从零起草',
  },
  {
    name: 'Excel',
    url: '/#/sheets',
    toggle: 'panai-toggle-ribbon-end',
    sheet: true,
    theme: 'rgb(16, 124, 65)',
    emptyCopy: '让PanAI帮你从零建表',
  },
  {
    name: 'PowerPoint',
    url: '/#/slides',
    toggle: 'panai-toggle',
    sheet: false,
    theme: 'rgb(210, 71, 38)',
    emptyCopy: '让PanAI为你生成演示文稿',
  },
  {
    name: 'PDF',
    url: `/#/pdf?src=${encodeURIComponent('/fixtures/hello.pdf')}`,
    toggle: 'panai-toggle',
    sheet: false,
    theme: null,
    emptyCopy: null,
  },
] as const

async function dockWidth(page: Page, sheet: boolean): Promise<number> {
  return page.getByTestId('panai-dock').evaluate((element, isSheet) => {
    if (isSheet) {
      const tracks = getComputedStyle(element).gridTemplateColumns.split(/\s+/)
      return Number.parseFloat(tracks.at(-1) ?? 'NaN')
    }
    return element.getBoundingClientRect().width
  }, sheet)
}

test('Word, Excel, PowerPoint and PDF use the ribbon button as the only PanAI toggle', async ({
  page,
}) => {
  for (const app of APPS) {
    await page.goto(app.url)
    const toggle = page.getByTestId(app.toggle)
    await expect(toggle, `${app.name} PanAI ribbon button`).toBeVisible({ timeout: 30_000 })

    const fileTheme = await page.locator('.ribbon-tab-file').evaluate((element) => {
      const style = getComputedStyle(element)
      return { color: style.backgroundColor, image: style.backgroundImage }
    })
    if (app.theme) {
      expect(fileTheme.color, `${app.name} Office theme`).toBe(app.theme)
      expect(fileTheme.image, `${app.name} file button is not a gradient`).toBe('none')
      await expect
        .poll(
          () =>
            page
              .locator('.ribbon-tabs > button.active')
              .first()
              .evaluate((element) => getComputedStyle(element).whiteSpace),
          { message: `${app.name} ribbon tabs stay on one line` },
        )
        .toBe('nowrap')
    } else {
      for (const color of ['rgb(24, 90, 189)', 'rgb(16, 124, 65)', 'rgb(210, 71, 38)'])
        expect(fileTheme.image, `PDF tricolor includes ${color}`).toContain(color)
    }

    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
    await expect(page.getByTestId('panai-panel'), `${app.name} panel open`).toBeVisible({
      timeout: 30_000,
    })
    if (app.emptyCopy) {
      await expect(page.getByText(app.emptyCopy, { exact: true })).toBeVisible()
    }
    await expect.poll(() => dockWidth(page, app.sheet)).toBeGreaterThan(250)

    // No duplicate title bar, canvas pill or collapsed rail may remain.
    await expect(page.locator('.ai-panel-header')).toHaveCount(0)
    await expect(page.locator('.ai-rail, .expand-copilot, .stage-ai-bar')).toHaveCount(0)

    await toggle.click()
    await expect(page.getByTestId('panai-panel'), `${app.name} panel closed`).toBeHidden()
    await expect.poll(() => dockWidth(page, app.sheet)).toBe(0)

    await toggle.click()
    await expect(page.getByTestId('panai-panel'), `${app.name} panel reopened`).toBeVisible()
  }
})

async function chooseFromFileMenu(page: Page, fixture: string): Promise<void> {
  await page.locator('.ribbon-tab-file').click()
  const chooserPromise = page.waitForEvent('filechooser')
  await page.locator('.file-tab-wrap > .file-menu > button:first-child').click()
  const chooser = await chooserPromise
  await chooser.setFiles(fixture)
}

async function slideText(page: Page): Promise<string> {
  try {
    return await page.evaluate(async () => {
      if (!window.slidesApi) return ''
      const slides = await window.slidesApi.getRenderSlides()
      if (!slides?.[0]) return ''
      const output: string[] = []
      type TextNode = {
        text?: { lines?: Array<{ runs?: Array<{ text: string }> }> }
        children?: TextNode[]
      }
      const walk = (nodes: readonly TextNode[]): void => {
        for (const node of nodes) {
          const text = node.text
          for (const line of text?.lines ?? [])
            for (const run of line.runs ?? []) output.push(run.text)
          if (node.children) walk(node.children)
        }
      }
      walk(slides[0].nodes as TextNode[])
      return output.join('')
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Execution context was destroyed')) return ''
    throw error
  }
}

async function excelA1DarkPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas')].sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0]
    const data = canvas?.getContext('2d')?.getImageData(48, 26, 84, 14).data
    if (!data) return -1
    let dark = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! > 200 && data[i]! < 120 && data[i + 1]! < 120 && data[i + 2]! < 120)
        dark++
    }
    return dark
  })
}

test('every editor File > Open switches directly to the selected Office format', async ({ page }) => {
  await page.goto('/#/docs')
  await expect(page.getByTestId('panai-toggle')).toBeVisible({ timeout: 30_000 })

  // Word -> PowerPoint
  await chooseFromFileMenu(page, 'public/fixtures/hello.pptx')
  await expect(page).toHaveURL(/#\/slides\?src=local%2Fhello\.pptx/)
  await expect.poll(() => slideText(page), { timeout: 30_000 }).toContain('Hello PanOffice')

  // PowerPoint -> PDF
  await chooseFromFileMenu(page, 'public/fixtures/hello.pdf')
  await expect(page).toHaveURL(/#\/pdf\?src=local%2Fhello\.pdf/)
  await expect(page.locator('.textLayer').first()).toContainText('Hello PanOffice', {
    timeout: 30_000,
  })

  // PDF -> Excel
  await chooseFromFileMenu(page, 'public/fixtures/hello.xlsx')
  await expect(page).toHaveURL(/#\/sheets\?src=local%2Fhello\.xlsx/)
  await expect(page.locator('#univer-container canvas').first()).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => excelA1DarkPixels(page), { timeout: 30_000 }).toBeGreaterThan(50)

  // Excel -> Word
  await chooseFromFileMenu(page, 'public/fixtures/simple.docx')
  await expect(page).toHaveURL(/#\/docs\?src=local%2Fsimple\.docx/)
  await expect(page.locator('body')).toContainText('第二段', { timeout: 30_000 })
})
