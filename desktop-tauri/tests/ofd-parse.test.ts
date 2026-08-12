import { readFileSync } from 'node:fs'
import { zipSync, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { parseDeltas, parseColor, parseOfd } from '../src/apps/ofd/parse'

/** Minimal but standard-shaped container: root → document → page. */
function buildOfd(overrides: Record<string, string> = {}): Uint8Array {
  const files: Record<string, string> = {
    'OFD.xml': `<?xml version="1.0" encoding="UTF-8"?>
<ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016" Version="1.1" DocType="OFD">
  <ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody>
</ofd:OFD>`,
    'Doc_0/Document.xml': `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Document xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:CommonData>
    <ofd:PageArea><ofd:PhysicalBox>0 0 210 140</ofd:PhysicalBox></ofd:PageArea>
    <ofd:PublicRes>PublicRes.xml</ofd:PublicRes>
    <ofd:TemplatePage ID="9" BaseLoc="Tpls/Tpl_0/Content.xml" />
  </ofd:CommonData>
  <ofd:Pages><ofd:Page ID="10" BaseLoc="Pages/Page_0/Content.xml" /></ofd:Pages>
</ofd:Document>`,
    'Doc_0/PublicRes.xml': `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Res xmlns:ofd="http://www.ofdspec.org/2016" BaseLoc="Res">
  <ofd:Fonts><ofd:Font ID="2" FontName="楷体" FamilyName="楷体" /></ofd:Fonts>
</ofd:Res>`,
    'Doc_0/Tpls/Tpl_0/Content.xml': `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:Content><ofd:Layer ID="1">
    <ofd:PathObject ID="12" Boundary="5 5 60 0.5" LineWidth="0.5">
      <ofd:AbbreviatedData>M 0 0 L 60 0</ofd:AbbreviatedData>
    </ofd:PathObject>
  </ofd:Layer></ofd:Content>
</ofd:Page>`,
    'Doc_0/Pages/Page_0/Content.xml': `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016">
  <ofd:Area><ofd:PhysicalBox>0 0 210 140</ofd:PhysicalBox></ofd:Area>
  <ofd:Template TemplateID="9" ZOrder="Background" />
  <ofd:Content><ofd:Layer ID="2">
    <ofd:TextObject ID="35" Boundary="68.5 7 80 6.35" Font="2" Size="6.7">
      <ofd:FillColor Value="156 82 35" />
      <ofd:TextCode X="0.95" Y="5.45" DeltaX="g 3 6.5">重庆增值税</ofd:TextCode>
    </ofd:TextObject>
  </ofd:Layer></ofd:Content>
</ofd:Page>`,
    ...overrides,
  }
  const zipped: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(files)) zipped[name] = strToU8(content)
  return zipSync(zipped)
}

describe('parseOfd', () => {
  it('reads pages, page geometry and template content', () => {
    const doc = parseOfd(buildOfd())
    expect(doc.pages).toHaveLength(1)
    expect(doc.pages[0]!.box).toEqual({ x: 0, y: 0, w: 210, h: 140 })
    // template path first (background), then the page's own text
    expect(doc.pages[0]!.objects.map((object) => object.kind)).toEqual(['path', 'text'])
  })

  it('keeps text vector data: content, placement, size, colour and font', () => {
    const doc = parseOfd(buildOfd())
    const run = doc.pages[0]!.objects.find((object) => object.kind === 'text')
    expect(run).toMatchObject({
      text: '重庆增值税',
      x: 0.95,
      y: 5.45,
      size: 6.7,
      fill: 'rgb(156 82 35)',
      font: '楷体',
      boundary: { x: 68.5, y: 7, w: 80, h: 6.35 },
    })
  })

  it('rejects a container without OFD.xml', () => {
    const notOfd = zipSync({ 'hello.txt': strToU8('hi') })
    expect(() => parseOfd(notOfd)).toThrow(/OFD/)
  })

  it('parses the real invoice-shaped sample end to end', () => {
    const path = `${process.env.HOME}/ai-native/projects/format-matrix/samples/generated/sample.ofd`
    const doc = parseOfd(readFileSync(path))
    expect(doc.pages.length).toBeGreaterThan(0)
    const texts = doc.pages
      .flatMap((page) => page.objects)
      .filter((object) => object.kind === 'text')
    // the invoice header must survive as selectable vector text, not an image
    expect(texts.some((run) => run.text.includes('增值税'))).toBe(true)
    expect(doc.signatures.length).toBeGreaterThan(0)
  })
})

describe('parseDeltas', () => {
  it('expands the run-length "g count value" form', () => {
    expect(parseDeltas('g 3 6.5')).toEqual([6.5, 6.5, 6.5])
    expect(parseDeltas('1 2 g 2 4 5')).toEqual([1, 2, 4, 4, 5])
    expect(parseDeltas('')).toEqual([])
  })
})

describe('parseColor', () => {
  const el = (xml: string): Element =>
    new DOMParser().parseFromString(xml, 'application/xml').documentElement

  it('maps RGB values and alpha onto css colours', () => {
    expect(parseColor(el('<FillColor Value="156 82 35" />'), null)).toBe('rgb(156 82 35)')
    expect(parseColor(el('<StrokeColor Value="0 0 0" Alpha="0" />'), null)).toBe('rgba(0 0 0 / 0)')
    expect(parseColor(null, 'rgb(0 0 0)')).toBe('rgb(0 0 0)')
  })
})
