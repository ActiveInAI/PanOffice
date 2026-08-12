/**
 * Native OFD (GB/T 33190-2016) container parser.
 *
 * OFD is a ZIP of XML: OFD.xml → Document.xml → per-page Content.xml, with
 * shared resources (fonts, colour spaces, images) in PublicRes/DocumentRes.
 * Everything here is pure data — no DOM painting — so the page model can be
 * unit-tested and reused by any renderer.
 *
 * Coordinates are millimetres throughout, exactly as the standard states;
 * the renderer applies one mm→px scale at draw time.
 */
import { unzipSync } from 'fflate'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 6-value transform [a b c d e f] as carried by an object's CTM. */
export type Matrix = readonly [number, number, number, number, number, number]

export interface TextRun {
  kind: 'text'
  boundary: Box
  ctm: Matrix | null
  /** baseline start, relative to the boundary origin */
  x: number
  y: number
  /** per-glyph advances (mm); shorter than the text means "reuse the last" */
  deltaX: number[]
  deltaY: number[]
  text: string
  size: number
  fill: string
  font: string
}

export interface PathRun {
  kind: 'path'
  boundary: Box
  ctm: Matrix | null
  data: string
  lineWidth: number
  stroke: string | null
  fill: string | null
}

export interface ImageRun {
  kind: 'image'
  boundary: Box
  ctm: Matrix | null
  /** entry name inside the container, ready for `entries` lookup */
  path: string
}

export type PageObject = TextRun | PathRun | ImageRun

export interface OfdPage {
  /** page box in mm */
  box: Box
  objects: PageObject[]
}

export interface OfdDocument {
  pages: OfdPage[]
  /** raw ZIP entries, kept for image resources the renderer decodes lazily */
  entries: Record<string, Uint8Array>
  /** signature entries found in the container (presence only, never verified here) */
  signatures: string[]
  /** font id → family name, as declared by PublicRes */
  fonts: Record<string, string>
}

const NS_MATCH = /^(?:[^:]+:)?/

function localName(node: Element): string {
  return node.tagName.replace(NS_MATCH, '')
}

function childrenNamed(parent: Element, name: string): Element[] {
  const out: Element[] = []
  for (const child of Array.from(parent.children)) {
    if (localName(child) === name) out.push(child)
  }
  return out
}

function firstNamed(parent: Element, name: string): Element | null {
  return childrenNamed(parent, name)[0] ?? null
}

/** All descendants with this local name, document order. */
function descendantsNamed(root: Element | Document, name: string): Element[] {
  const out: Element[] = []
  const walk = (node: Element): void => {
    for (const child of Array.from(node.children)) {
      if (localName(child) === name) out.push(child)
      walk(child)
    }
  }
  if (root instanceof Document) {
    if (root.documentElement) {
      if (localName(root.documentElement) === name) out.push(root.documentElement)
      walk(root.documentElement)
    }
  } else {
    walk(root)
  }
  return out
}

function numbers(value: string | null | undefined): number[] {
  if (!value) return []
  const out: number[] = []
  for (const token of value.trim().split(/[\s,]+/)) {
    const n = Number(token)
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

function parseBox(value: string | null | undefined): Box | null {
  const [x, y, w, h] = numbers(value)
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null
  return { x, y, w, h }
}

function parseMatrix(value: string | null | undefined): Matrix | null {
  const m = numbers(value)
  return m.length === 6 ? ([m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!] as const) : null
}

/**
 * `DeltaX`/`DeltaY` accept a run-length form: `g <count> <value>` repeats a
 * value, mixed freely with plain numbers.
 */
export function parseDeltas(value: string | null | undefined): number[] {
  if (!value) return []
  const tokens = value.trim().split(/[\s,]+/).filter(Boolean)
  const out: number[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (token === 'g' || token === 'G') {
      const count = Number(tokens[i + 1])
      const step = Number(tokens[i + 2])
      if (Number.isFinite(count) && Number.isFinite(step)) {
        for (let k = 0; k < count; k += 1) out.push(step)
      }
      i += 2
      continue
    }
    const n = Number(token)
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/** `Value="156 82 35"` → css colour; alpha comes from the sibling attribute. */
export function parseColor(node: Element | null, fallback: string | null): string | null {
  if (!node) return fallback
  const parts = numbers(node.getAttribute('Value'))
  if (parts.length < 3) return fallback
  const alphaAttr = node.getAttribute('Alpha')
  const alpha = alphaAttr === null ? 1 : Math.max(0, Math.min(255, Number(alphaAttr))) / 255
  const [r, g, b] = parts
  if (alpha >= 1) return `rgb(${r} ${g} ${b})`
  return `rgba(${r} ${g} ${b} / ${alpha})`
}

function decodeXml(bytes: Uint8Array | undefined): Document | null {
  if (!bytes) return null
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '')
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  return doc.querySelector('parsererror') ? null : doc
}

/** Join an OFD relative location against the directory holding it. */
function resolvePath(baseDir: string, loc: string): string {
  const clean = loc.replace(/^\/+/, '')
  if (!baseDir) return clean
  const parts = `${baseDir}/${clean}`.split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

function dirOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function collectObjects(root: Element, fonts: Record<string, string>, resDir: string, media: Record<string, string>): PageObject[] {
  const objects: PageObject[] = []
  for (const node of descendantsNamed(root, 'TextObject')) {
    const boundary = parseBox(node.getAttribute('Boundary'))
    if (!boundary) continue
    const size = Number(node.getAttribute('Size') ?? 3)
    const fill = parseColor(firstNamed(node, 'FillColor'), 'rgb(0 0 0)') ?? 'rgb(0 0 0)'
    const fontId = node.getAttribute('Font') ?? ''
    for (const code of childrenNamed(node, 'TextCode')) {
      const text = code.textContent ?? ''
      if (!text) continue
      objects.push({
        kind: 'text',
        boundary,
        ctm: parseMatrix(node.getAttribute('CTM')),
        x: Number(code.getAttribute('X') ?? 0),
        y: Number(code.getAttribute('Y') ?? 0),
        deltaX: parseDeltas(code.getAttribute('DeltaX')),
        deltaY: parseDeltas(code.getAttribute('DeltaY')),
        text,
        size: Number.isFinite(size) ? size : 3,
        fill,
        font: fonts[fontId] ?? '',
      })
    }
  }
  for (const node of descendantsNamed(root, 'PathObject')) {
    const boundary = parseBox(node.getAttribute('Boundary'))
    const data = firstNamed(node, 'AbbreviatedData')?.textContent ?? ''
    if (!boundary || !data.trim()) continue
    // Per the standard a path strokes by default and only fills when asked.
    const wantsStroke = node.getAttribute('Stroke') !== 'false'
    const wantsFill = node.getAttribute('Fill') === 'true'
    objects.push({
      kind: 'path',
      boundary,
      ctm: parseMatrix(node.getAttribute('CTM')),
      data,
      lineWidth: Number(node.getAttribute('LineWidth') ?? 0.25) || 0.25,
      stroke: wantsStroke ? (parseColor(firstNamed(node, 'StrokeColor'), 'rgb(0 0 0)') ?? 'rgb(0 0 0)') : null,
      fill: wantsFill ? (parseColor(firstNamed(node, 'FillColor'), 'rgb(0 0 0)') ?? 'rgb(0 0 0)') : null,
    })
  }
  for (const node of descendantsNamed(root, 'ImageObject')) {
    const boundary = parseBox(node.getAttribute('Boundary'))
    const resourceId = node.getAttribute('ResourceID') ?? ''
    const file = media[resourceId]
    if (!boundary || !file) continue
    objects.push({
      kind: 'image',
      boundary,
      ctm: parseMatrix(node.getAttribute('CTM')),
      path: resolvePath(resDir, file),
    })
  }
  return objects
}

/**
 * Parse a whole OFD container into renderable pages. Synchronous and
 * allocation-light: invoices are small, and one pass keeps first paint fast.
 */
export function parseOfd(buffer: ArrayBuffer | Uint8Array): OfdDocument {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const entries = unzipSync(bytes) as Record<string, Uint8Array>

  const rootName = Object.keys(entries).find((name) => /(^|\/)OFD\.xml$/i.test(name))
  if (!rootName) throw new Error('不是有效的 OFD 文件：缺少 OFD.xml')
  const rootDoc = decodeXml(entries[rootName])
  if (!rootDoc) throw new Error('OFD.xml 解析失败')
  const rootDir = dirOf(rootName)

  const docRootLoc =
    descendantsNamed(rootDoc, 'DocRoot')[0]?.textContent?.trim() ?? 'Doc_0/Document.xml'
  const docPath = resolvePath(rootDir, docRootLoc)
  const documentDoc = decodeXml(entries[docPath])
  if (!documentDoc) throw new Error('Document.xml 解析失败')
  const docDir = dirOf(docPath)

  // shared resources: fonts (id → family) and images (id → file name)
  const fonts: Record<string, string> = {}
  const media: Record<string, string> = {}
  const resLocs = [
    ...descendantsNamed(documentDoc, 'PublicRes'),
    ...descendantsNamed(documentDoc, 'DocumentRes'),
  ]
    .map((node) => node.textContent?.trim())
    .filter((loc): loc is string => Boolean(loc))
  let resDir = docDir
  for (const loc of resLocs) {
    const resPath = resolvePath(docDir, loc)
    const resDoc = decodeXml(entries[resPath])
    if (!resDoc) continue
    const baseLoc = resDoc.documentElement?.getAttribute('BaseLoc') ?? ''
    const mediaDir = resolvePath(dirOf(resPath), baseLoc)
    for (const font of descendantsNamed(resDoc, 'Font')) {
      const id = font.getAttribute('ID')
      if (id) fonts[id] = font.getAttribute('FamilyName') ?? font.getAttribute('FontName') ?? ''
    }
    for (const item of descendantsNamed(resDoc, 'MultiMedia')) {
      const id = item.getAttribute('ID')
      const file = firstNamed(item, 'MediaFile')?.textContent?.trim()
      if (id && file) {
        media[id] = file
        resDir = mediaDir
      }
    }
  }

  const docPageArea = parseBox(
    descendantsNamed(documentDoc, 'PhysicalBox')[0]?.textContent,
  ) ?? { x: 0, y: 0, w: 210, h: 297 }

  // template pages are shared backgrounds referenced per page by ID
  const templates: Record<string, PageObject[]> = {}
  for (const template of descendantsNamed(documentDoc, 'TemplatePage')) {
    const id = template.getAttribute('ID')
    const loc = template.getAttribute('BaseLoc')
    if (!id || !loc) continue
    const tplDoc = decodeXml(entries[resolvePath(docDir, loc)])
    if (!tplDoc?.documentElement) continue
    templates[id] = collectObjects(tplDoc.documentElement, fonts, resDir, media)
  }

  const pages: OfdPage[] = []
  for (const pageNode of descendantsNamed(documentDoc, 'Page')) {
    const loc = pageNode.getAttribute('BaseLoc')
    if (!loc) continue
    const pageDoc = decodeXml(entries[resolvePath(docDir, loc)])
    if (!pageDoc?.documentElement) continue
    const root = pageDoc.documentElement
    const box = parseBox(descendantsNamed(root, 'PhysicalBox')[0]?.textContent) ?? docPageArea
    // background templates paint first, then the page's own content
    const objects: PageObject[] = []
    for (const ref of descendantsNamed(root, 'Template')) {
      const id = ref.getAttribute('TemplateID')
      if (id && templates[id]) objects.push(...templates[id])
    }
    objects.push(...collectObjects(root, fonts, resDir, media))
    pages.push({ box, objects })
  }

  const signatures = Object.keys(entries).filter((name) => /Signatures?\.xml$/i.test(name))
  return { pages, entries, signatures, fonts }
}
