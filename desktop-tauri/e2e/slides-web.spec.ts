import { expect, test, type Page } from '@playwright/test'
import { copyFileSync, readFileSync } from 'node:fs'
import JSZip from 'jszip'

/**
 * Web-side slides editing acceptance: the PanOffice slides editor (Tauri
 * frontend on :4180) opens hello.pptx straight from the wopi-host (:3210)
 * over HTTP, edits the slide-1 title through the real UI (double-click →
 * contentEditable overlay → type → blur-commit), and the save POSTs the
 * patched package back to the server (PutFile-style) instead of the
 * IndexedDB overlay.
 *
 * Byte-level proof polls the on-disk file, bypassing the app entirely. The
 * slide is canvas-rendered (Konva), so rendering is asserted on canvas
 * pixels via the bridge render tree exactly like e2e/slides.spec.ts — see
 * that file for the coordinate mapping notes.
 */

const FILE = 'hello.pptx'
const SERVER_FILE = `../deploy/data/files/${FILE}`
const SRC = `http://127.0.0.1:3210/wopi/files/${FILE}/contents?access_token=devtoken`
const MARKER = 'E2E-WEB'
const BLEED = 160 // CANVAS_BLEED in SlideCanvas.tsx

test.setTimeout(90_000)

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

interface NodeRect {
  /** canvas-bitmap coordinates (for getImageData) */
  bx: number
  by: number
  bw: number
  bh: number
  /** client coordinates of the node center (for mouse events) */
  clientX: number
  clientY: number
}

/**
 * The slide-1 title node's rect, or null while the deck is still opening.
 * Never throws: readiness is the caller's polled condition.
 */
async function tryTitleNodeRect(page: Page): Promise<NodeRect | null> {
  return page.evaluate((bleed) => {
    const api = window.slidesApi
    if (!api) return null
    return api.getRenderSlides().then((slides) => {
      const slide = slides?.[0]
      if (!slide) return null
      const node = slide.nodes.find(
        (n) =>
          (n.type === 'text' || n.type === 'shape') &&
          ((n as { text?: { lines?: unknown[] } }).text?.lines?.length ?? 0) > 0,
      ) as { box: { x: number; y: number; w: number; h: number } } | undefined
      if (!node) return null
      const canvas = [...document.querySelectorAll('canvas')].sort(
        (a, b) => b.width * b.height - a.width * a.height,
      )[0]
      const stageW = parseFloat(canvas?.parentElement?.style.width ?? '')
      if (!canvas || !Number.isFinite(stageW) || stageW <= 0) return null
      const rect = canvas.getBoundingClientRect()
      const bitScale = canvas.width / stageW
      const cssScale = rect.width / stageW
      return {
        bx: (bleed + node.box.x) * bitScale,
        by: (bleed + node.box.y) * bitScale,
        bw: node.box.w * bitScale,
        bh: node.box.h * bitScale,
        clientX: rect.x + (bleed + node.box.x + node.box.w / 2) * cssScale,
        clientY: rect.y + (bleed + node.box.y + node.box.h / 2) * cssScale,
      }
    })
  }, BLEED)
}

/** Count dark opaque pixels in a rect of the main canvas (canvas-bitmap coordinates) */
async function canvasDarkPixels(
  page: Page,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<number> {
  return page.evaluate(
    ([rx, ry, rw, rh]) => {
      const canvas = [...document.querySelectorAll('canvas')].sort(
        (a, b) => b.width * b.height - a.width * a.height,
      )[0]
      const ctx = canvas?.getContext('2d')
      if (!ctx) return -1
      const data = ctx.getImageData(rx!, ry!, rw!, rh!).data
      let dark = 0
      for (let i = 0; i < data.length; i += 4) {
        // transparent pixels read as black — require opacity first
        if (data[i + 3]! > 200 && data[i]! < 120 && data[i + 1]! < 120 && data[i + 2]! < 120) {
          dark++
        }
      }
      return dark
    },
    [x, y, w, h] as const,
  )
}

/** Poll until the deck is open and the title band shows text pixels */
async function expectTitleText(page: Page, threshold: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const t = await tryTitleNodeRect(page)
        if (!t) return -1
        return canvasDarkPixels(page, t.bx + 4, t.by + 2, Math.max(t.bw - 8, 8), Math.max(t.bh - 4, 6))
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(threshold)
}

/** The main edit canvas is the largest canvas in the page (thumbnails are smaller) */
async function mainCanvasRect(
  page: Page,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas')].sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0]
    if (!canvas) return null
    const r = canvas.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
}

/**
 * The stage re-fits asynchronously after first paint: wait until the canvas
 * client rect is stable across samples before translating render-tree
 * coordinates into mouse coordinates.
 */
async function waitForStageSettled(page: Page): Promise<void> {
  let last: string | null = null
  let stable = 0
  await expect
    .poll(
      async () => {
        const r = await mainCanvasRect(page)
        const key = r ? `${r.x},${r.y},${r.w},${r.h}` : 'none'
        stable = key === last ? stable + 1 : 0
        last = key
        return stable
      },
      { timeout: 20_000, intervals: [400] },
    )
    .toBeGreaterThanOrEqual(3)
}

/** Slide-1 text content via the bridge render tree (all runs concatenated) */
async function slide1Text(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const slides = await window.slidesApi.getRenderSlides()
    if (!slides?.length) return ''
    const out: string[] = []
    const walk = (nodes: (typeof slides)[0]['nodes']): void => {
      for (const n of nodes) {
        const text = (n as { text?: { lines?: Array<{ runs?: Array<{ text: string }> }> } }).text
        if (text?.lines) for (const l of text.lines) for (const r of l.runs ?? []) out.push(r.text)
        const children = (n as { children?: typeof nodes }).children
        if (children) walk(children)
      }
    }
    walk(slides[0]!.nodes)
    return out.join('')
  })
}

test('open pptx from wopi-host, edit title in browser, save lands on server disk', async ({
  page,
}) => {
  // pristine starting state (and no foreign WOPI lock on the fixture)
  await forceUnlockFixture()
  copyFileSync(`public/fixtures/${FILE}`, SERVER_FILE)

  await page.goto(`/#/slides?src=${encodeURIComponent(SRC)}`)

  // Slide 1 renders: "Hello PanOffice" title pixels in its node band.
  await expectTitleText(page, 50)
  await expect.poll(() => slide1Text(page), { timeout: 15_000 }).toContain('Hello PanOffice')

  // The stage keeps re-fitting after first paint, so mouse coordinates are
  // only computed once the canvas client rect is stable
  await waitForStageSettled(page)

  // One edit through the real UI: double-click the title node on the canvas →
  // the contentEditable overlay opens → type the marker → click away to commit.
  const t = (await tryTitleNodeRect(page))!
  expect(t).toBeTruthy()
  await page.mouse.dblclick(t.clientX, t.clientY)
  const overlay = page.locator('[contenteditable="true"]').first()
  await overlay.waitFor({ state: 'visible', timeout: 10_000 })
  await page.keyboard.type(MARKER)
  // blur commits the edit (blur → commitEdit → slidesApi.editText); click the
  // canvas's bleed corner — outside any node
  const canvasRect = await page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas')].sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0]!
    const r = canvas.getBoundingClientRect()
    return { x: r.x, y: r.y }
  })
  await page.mouse.click(canvasRect.x + 8, canvasRect.y + 8)
  await expect.poll(() => slide1Text(page), { timeout: 15_000 }).toContain(MARKER)

  // Quick-access Save → host save pipeline → pptx-engine patch → bridge POST.
  // Completion signal: the marker lands on the SERVER's disk (the wopi-host
  // writes via temp+rename, so every poll reads a whole zip).
  await page.locator('.ribbon-tabs .qa-btn').first().click()
  await expect
    .poll(
      async () => {
        const zip = await JSZip.loadAsync(readFileSync(SERVER_FILE))
        const slide1Xml = await zip.file('ppt/slides/slide1.xml')?.async('string')
        return slide1Xml?.includes(MARKER) ?? false
      },
      { timeout: 60_000 },
    )
    .toBe(true)
  // The post-save adopt swaps the render tree; let it settle.
  await page.waitForTimeout(1_000)

  // Byte-level proof on the server-disk file: the untouched slide 2 survives
  const zip = await JSZip.loadAsync(readFileSync(SERVER_FILE))
  const slide2Xml = await zip.file('ppt/slides/slide2.xml')?.async('string')
  expect(slide2Xml).toContain('Second slide')

  // reload re-fetches from the server (not any local overlay) and keeps the edit
  await page.reload()
  await expectTitleText(page, 50)
  await expect.poll(() => slide1Text(page), { timeout: 15_000 }).toContain(MARKER)

  // restore pristine fixture for the next run
  copyFileSync(`public/fixtures/${FILE}`, SERVER_FILE)
})
