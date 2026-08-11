import { expect, test, type Page } from '@playwright/test'
import JSZip from 'jszip'

/**
 * Slides-port acceptance: open the fixture pptx through the ported Konva
 * editor, edit the slide-1 title via the real UI (double-click the text node
 * on the canvas → the contentEditable overlay opens → type a marker → click
 * away to blur-commit), save via the quick-access Save button, reload, and
 * prove the edit persisted.
 *
 * The save pipeline runs entirely in the webview: the host
 * (src/apps/slides/main/slides-host.ts) patches the package with pptx-engine
 * and writes the bytes through the bridge byte-store (IndexedDB overlay in the
 * browser). Persistence is asserted on the bytes: the saved file comes back
 * out of the overlay and ppt/slides/slide1.xml is unzipped here in Node with
 * jszip.
 *
 * The slide is canvas-rendered (Konva — no DOM text, like the sheets grid), so
 * rendering is asserted on canvas pixels: dark-opaque pixels inside the title
 * node's band vs an empty control band. The title node's box comes from the
 * bridge itself (window.slidesApi.getRenderSlides() — the same render tree the
 * canvas draws), so no layout coordinates are hardcoded.
 *
 * Coordinate mapping (verified by probing the booted app): the render tree's
 * node boxes are in fitWidth (1280px) slide space; the Konva stage adds
 * CANVAS_BLEED (160) around the slide, so stage space = slide space + 160.
 * The canvas bitmap is stage-space × (canvas.width / stageCssWidth), and the
 * on-screen rect is stage-space × (rect.width / stageCssWidth) via the
 * .stage-scale CSS transform — stageCssWidth is the .konvajs-content style
 * width (1600 here).
 */

const FIXTURE = '/fixtures/hello.pptx'
const MARKER = 'E2E-EDIT'
const BLEED = 160 // CANVAS_BLEED in SlideCanvas.tsx

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
 * The stage re-fits asynchronously after first paint (observed 510→907px wide
 * ~1s in): wait until the canvas client rect is stable across samples before
 * translating render-tree coordinates into mouse coordinates.
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

/** Read the saved bytes from the bridge byte-store (IndexedDB overlay); null if absent */
async function readOverlayBase64(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async (key) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('panoffice', 1)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('idb open failed'))
    })
    const bytes = await new Promise<Uint8Array | null>((resolve, reject) => {
      const req = db.transaction('files', 'readonly').objectStore('files').get(key)
      req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null)
      req.onerror = () => reject(req.error ?? new Error('idb get failed'))
    })
    if (!bytes) return null
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return btoa(bin)
  }, path)
}

test('open, edit title via real UI, save, reload — marker persists in the pptx bytes', async ({
  page,
}) => {
  await page.goto(`/#/slides?src=${FIXTURE}`)

  // Slide 1 renders: "Hello PanOffice" title pixels in its node band. Readiness
  // is polled on canvas pixels because the Konva stage has no DOM text (same
  // approach as the sheets spec).
  await expectTitleText(page, 50)
  await expect.poll(() => slide1Text(page), { timeout: 15_000 }).toContain('Hello PanOffice')

  // The stage keeps re-fitting after first paint (observed ~2x width change in
  // the first second), so mouse coordinates are only computed once the canvas
  // client rect is stable
  await waitForStageSettled(page)

  // Control band: inside the slide near its bottom edge — slide 1 has no other
  // nodes, so it must be empty (white background, zero dark pixels)
  const t = (await tryTitleNodeRect(page))!
  expect(t).toBeTruthy()
  const canvasInfo = await page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas')].sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0]!
    return { w: canvas.width, h: canvas.height }
  })
  expect(await canvasDarkPixels(page, t.bx + 4, canvasInfo.h - BLEED - 60, 120, 20)).toBe(0)

  // One edit through the real UI: double-click the title node on the canvas →
  // the contentEditable overlay opens → type the marker → click away to commit.
  await page.mouse.dblclick(t.clientX, t.clientY)
  const overlay = page.locator('[contenteditable="true"]').first()
  await overlay.waitFor({ state: 'visible', timeout: 10_000 })
  await page.keyboard.type(MARKER)
  // blur commits the edit (upstream: blur → commitEdit → slidesApi.editText);
  // click the canvas's bleed corner — outside any node
  const canvasRect = await page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas')].sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0]!
    const r = canvas.getBoundingClientRect()
    return { x: r.x, y: r.y }
  })
  await page.mouse.click(canvasRect.x + 8, canvasRect.y + 8)
  await expect.poll(() => slide1Text(page), { timeout: 15_000 }).toContain(MARKER)

  // Quick-access Save → host save pipeline → pptx-engine patch → bridge write.
  // Completion is signaled by the saved bytes landing in the byte-store.
  await page.locator('.ribbon-tabs .qa-btn').first().click()
  let b64: string | null = null
  await expect
    .poll(
      async () => {
        b64 = await readOverlayBase64(page, FIXTURE)
        return b64 !== null
      },
      { timeout: 60_000 },
    )
    .toBe(true)
  if (b64 === null) throw new Error('unreachable')
  // The post-save adopt swaps the render tree (all-new element ids); let it settle.
  await page.waitForTimeout(1_000)

  // Full page reload: the editor must reopen from persisted state (IDB overlay)
  await page.reload()
  await expectTitleText(page, 50)
  await expect.poll(() => slide1Text(page), { timeout: 15_000 }).toContain(MARKER)

  // Byte-level proof: the saved bytes came back out of the bridge byte-store
  // above; unzip them here in Node
  const zip = await JSZip.loadAsync(Buffer.from(b64, 'base64'))
  const slide1Xml = await zip.file('ppt/slides/slide1.xml')?.async('string')
  const slide2Xml = await zip.file('ppt/slides/slide2.xml')?.async('string')
  expect(slide1Xml).toBeTruthy()
  expect(slide1Xml).toContain(MARKER)
  // the untouched second slide survives the patch-save
  expect(slide2Xml).toContain('Second slide')
})
