/**
 * Canvas painter for the parsed OFD page model.
 *
 * Everything is drawn in millimetre space: the context is scaled once by
 * px-per-mm, so object boundaries, font sizes and line widths go in exactly
 * as the document declares them. Glyphs advance by the document's own
 * DeltaX/DeltaY, which is what makes the layout match the issuer's intent
 * instead of relying on the browser's metrics for a substituted font.
 */
import type { Matrix, OfdDocument, OfdPage, PageObject } from './parse'

/** OFD names Chinese system fonts; map them onto what a browser can serve. */
const FONT_STACKS: Record<string, string> = {
  楷体: '"KaiTi", "STKaiti", "Kaiti SC", serif',
  楷体_GB2312: '"KaiTi", "STKaiti", serif',
  仿宋: '"FangSong", "STFangsong", serif',
  仿宋_GB2312: '"FangSong", "STFangsong", serif',
  宋体: '"SimSun", "Songti SC", serif',
  新宋体: '"NSimSun", "SimSun", serif',
  黑体: '"SimHei", "Heiti SC", sans-serif',
  微软雅黑: '"Microsoft YaHei", sans-serif',
  等线: '"DengXian", sans-serif',
}

export function fontStack(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '"SimSun", serif'
  return FONT_STACKS[trimmed] ?? `"${trimmed}", "SimSun", serif`
}

function applyPlacement(ctx: CanvasRenderingContext2D, boundary: { x: number; y: number }, ctm: Matrix | null): void {
  ctx.translate(boundary.x, boundary.y)
  if (ctm) ctx.transform(ctm[0], ctm[1], ctm[2], ctm[3], ctm[4], ctm[5])
}

/**
 * Walk an `AbbreviatedData` program onto the context path.
 * Ops per GB/T 33190: S/M move, L line, Q quadratic, B cubic, A arc, C close.
 */
export function tracePath(ctx: CanvasRenderingContext2D, data: string): void {
  const tokens = data.trim().split(/[\s,]+/).filter(Boolean)
  let i = 0
  let cx = 0
  let cy = 0
  const num = (): number => {
    const value = Number(tokens[i])
    i += 1
    return Number.isFinite(value) ? value : 0
  }
  ctx.beginPath()
  while (i < tokens.length) {
    const op = tokens[i]!
    i += 1
    switch (op) {
      case 'S':
      case 'M': {
        cx = num()
        cy = num()
        ctx.moveTo(cx, cy)
        break
      }
      case 'L': {
        cx = num()
        cy = num()
        ctx.lineTo(cx, cy)
        break
      }
      case 'Q': {
        const x1 = num()
        const y1 = num()
        cx = num()
        cy = num()
        ctx.quadraticCurveTo(x1, y1, cx, cy)
        break
      }
      case 'B': {
        const x1 = num()
        const y1 = num()
        const x2 = num()
        const y2 = num()
        cx = num()
        cy = num()
        ctx.bezierCurveTo(x1, y1, x2, y2, cx, cy)
        break
      }
      case 'A': {
        // rx ry rotation large sweep x y — browsers have no direct
        // equivalent, so approximate with the endpoint segment rather than
        // dropping the subpath (arcs are rare outside decorative borders).
        num()
        num()
        num()
        num()
        num()
        cx = num()
        cy = num()
        ctx.lineTo(cx, cy)
        break
      }
      case 'C': {
        ctx.closePath()
        break
      }
      default:
        // unknown op: skip its token, the loop already advanced
        break
    }
  }
}

function drawText(ctx: CanvasRenderingContext2D, run: Extract<PageObject, { kind: 'text' }>): void {
  ctx.save()
  applyPlacement(ctx, run.boundary, run.ctm)
  ctx.fillStyle = run.fill
  ctx.font = `${run.size}px ${fontStack(run.font)}`
  ctx.textBaseline = 'alphabetic'
  const glyphs = Array.from(run.text)
  let x = run.x
  let y = run.y
  for (let index = 0; index < glyphs.length; index += 1) {
    ctx.fillText(glyphs[index]!, x, y)
    // A short delta list means "keep using the last advance" — issuers rely
    // on this for runs of identical-width glyphs.
    const dx = run.deltaX.length > 0 ? (run.deltaX[index] ?? run.deltaX[run.deltaX.length - 1]!) : run.size
    const dy = run.deltaY.length > 0 ? (run.deltaY[index] ?? run.deltaY[run.deltaY.length - 1]!) : 0
    x += dx
    y += dy
  }
  ctx.restore()
}

function drawPath(ctx: CanvasRenderingContext2D, run: Extract<PageObject, { kind: 'path' }>): void {
  ctx.save()
  applyPlacement(ctx, run.boundary, run.ctm)
  tracePath(ctx, run.data)
  if (run.fill) {
    ctx.fillStyle = run.fill
    ctx.fill()
  }
  if (run.stroke) {
    ctx.strokeStyle = run.stroke
    ctx.lineWidth = run.lineWidth
    ctx.stroke()
  }
  ctx.restore()
}

function drawImage(
  ctx: CanvasRenderingContext2D,
  run: Extract<PageObject, { kind: 'image' }>,
  bitmap: CanvasImageSource,
): void {
  ctx.save()
  applyPlacement(ctx, run.boundary, run.ctm)
  // An image object's CTM maps the unit square onto the placed area.
  ctx.drawImage(bitmap, 0, 0, run.ctm ? 1 : run.boundary.w, run.ctm ? 1 : run.boundary.h)
  ctx.restore()
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
}

/** Decode every image a page needs, once, before painting. */
export async function loadPageImages(
  doc: OfdDocument,
  page: OfdPage,
  cache: Map<string, ImageBitmap>,
): Promise<Map<string, ImageBitmap>> {
  const wanted = new Set<string>()
  for (const object of page.objects) {
    if (object.kind === 'image' && !cache.has(object.path)) wanted.add(object.path)
  }
  await Promise.all(
    [...wanted].map(async (path) => {
      const bytes = doc.entries[path]
      if (!bytes) return
      const ext = path.split('.').pop()?.toLowerCase() ?? ''
      const blob = new Blob([bytes as unknown as BlobPart], {
        type: MIME_BY_EXT[ext] ?? 'application/octet-stream',
      })
      try {
        cache.set(path, await createImageBitmap(blob))
      } catch {
        // an unreadable resource must not take the whole page down
      }
    }),
  )
  return cache
}

/**
 * Paint one page. `scale` is px per mm (zoom × device pixel ratio); the
 * caller sizes the canvas accordingly.
 */
export function renderPage(
  ctx: CanvasRenderingContext2D,
  page: OfdPage,
  scale: number,
  images: Map<string, ImageBitmap>,
): void {
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, page.box.w * scale, page.box.h * scale)
  ctx.scale(scale, scale)
  ctx.translate(-page.box.x, -page.box.y)
  for (const object of page.objects) {
    if (object.kind === 'text') drawText(ctx, object)
    else if (object.kind === 'path') drawPath(ctx, object)
    else {
      const bitmap = images.get(object.path)
      if (bitmap) drawImage(ctx, object, bitmap)
    }
  }
  ctx.restore()
}
