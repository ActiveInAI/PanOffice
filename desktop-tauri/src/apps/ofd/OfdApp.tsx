import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { platform } from '../../bridge/platform'
import { LOGO_SVG } from '../../branding'
import { wopiDisplayName } from '../../server-files'
import { parseOfd, type OfdDocument, type OfdPage } from './parse'
import { fontStack, loadPageImages, renderPage } from './render'

/**
 * Native OFD viewer: the container is unzipped and painted in the browser,
 * with no server-side conversion in the path. Pages render on demand at
 * device resolution, and every text run also lands in a transparent HTML
 * layer so the invoice stays selectable, searchable and copyable.
 */

const MM_TO_CSS_PX = 96 / 25.4

function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))
  useEffect(() => {
    const media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const onChange = () => setDpr(window.devicePixelRatio || 1)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [dpr])
  return dpr
}

function PageView({
  doc,
  page,
  index,
  zoom,
  dpr,
  imageCache,
  onPainted,
}: {
  doc: OfdDocument
  page: OfdPage
  index: number
  zoom: number
  dpr: number
  imageCache: Map<string, ImageBitmap>
  onPainted: (index: number, ms: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(index === 0)

  // Only pages the reader can actually see get painted — a 20-page document
  // must not cost 20 canvases up front.
  useEffect(() => {
    const host = hostRef.current
    if (!host || visible) return
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '400px' },
    )
    observer.observe(host)
    return () => observer.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const canvas = canvasRef.current
    if (!canvas) return
    const scale = MM_TO_CSS_PX * zoom * dpr
    canvas.width = Math.round(page.box.w * scale)
    canvas.height = Math.round(page.box.h * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let cancelled = false
    void loadPageImages(doc, page, imageCache).then((images) => {
      if (cancelled) return
      const started = performance.now()
      renderPage(ctx, page, scale, images)
      onPainted(index, performance.now() - started)
    })
    return () => {
      cancelled = true
    }
  }, [visible, zoom, dpr, doc, page, index, imageCache, onPainted])

  const cssWidth = page.box.w * MM_TO_CSS_PX * zoom
  const cssHeight = page.box.h * MM_TO_CSS_PX * zoom

  return (
    <div
      ref={hostRef}
      data-testid={`ofd-page-${index}`}
      style={{
        position: 'relative',
        width: cssWidth,
        height: cssHeight,
        margin: '0 auto 16px',
        background: '#fff',
        boxShadow: '0 1px 6px rgba(0,0,0,0.14)',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: cssWidth, height: cssHeight, display: 'block' }}
      />
      {/* selectable text layer: transparent glyph runs over the canvas */}
      <div
        className="ofd-text-layer"
        style={{ position: 'absolute', inset: 0, color: 'transparent', overflow: 'hidden' }}
      >
        {visible &&
          page.objects.map((object, objectIndex) => {
            if (object.kind !== 'text') return null
            const left = (object.boundary.x - page.box.x + object.x) * MM_TO_CSS_PX * zoom
            const top = (object.boundary.y - page.box.y + object.y - object.size) * MM_TO_CSS_PX * zoom
            return (
              <span
                key={objectIndex}
                style={{
                  position: 'absolute',
                  left,
                  top,
                  fontSize: object.size * MM_TO_CSS_PX * zoom,
                  fontFamily: fontStack(object.font),
                  lineHeight: 1,
                  whiteSpace: 'pre',
                  cursor: 'text',
                }}
              >
                {object.text}
              </span>
            )
          })}
      </div>
    </div>
  )
}

export function OfdApp() {
  const query = window.location.hash.split('?')[1] ?? ''
  const src = new URLSearchParams(query).get('src') ?? ''
  const name = wopiDisplayName(src) ?? src.split(/[\\/]/).pop() ?? src
  const dpr = useDevicePixelRatio()
  const [doc, setDoc] = useState<OfdDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [timing, setTiming] = useState<{ bytes: number; fetchMs: number; parseMs: number; paintMs: number } | null>(
    null,
  )
  const imageCache = useMemo(() => new Map<string, ImageBitmap>(), [])

  useEffect(() => {
    if (!src) {
      setError('无法识别文档来源')
      return
    }
    let alive = true
    const t0 = performance.now()
    platform
      .readFile(src)
      .then((bytes) => {
        if (!alive) return
        const fetched = performance.now()
        const parsed = parseOfd(bytes)
        const done = performance.now()
        setDoc(parsed)
        setTiming({
          bytes: bytes.byteLength,
          fetchMs: fetched - t0,
          parseMs: done - fetched,
          paintMs: 0,
        })
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [src])

  const onPainted = useCallback((index: number, ms: number) => {
    if (index !== 0) return
    setTiming((current) => (current ? { ...current, paintMs: ms } : current))
  }, [])

  if (error !== null) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          color: '#b45309',
          padding: 24,
          textAlign: 'center',
        }}
      >
        无法打开 OFD：{error}
      </div>
    )
  }

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: '#f3f4f6' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 36,
          padding: '0 12px',
          borderBottom: '1px solid #e5e7eb',
          background: '#f9fafb',
          font: '13px system-ui, sans-serif',
          flexShrink: 0,
        }}
      >
        <img src={LOGO_SVG} alt="" width={18} height={18} />
        <a href="#/" style={{ color: '#2563eb', textDecoration: 'none' }}>
          ← 主页
        </a>
        <span style={{ color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name}
        </span>
        {doc && (
          <span style={{ fontSize: 12, color: '#6b7280' }} data-testid="ofd-pagecount">
            {doc.pages.length} 页
          </span>
        )}
        {doc && doc.signatures.length > 0 && (
          <span
            data-testid="ofd-signature-badge"
            title="文档内含签章数据；本页仅展示存在性，不代表已完成验签"
            style={{
              fontSize: 11,
              color: '#7c3aed',
              border: '1px solid #ddd6fe',
              background: '#f5f3ff',
              borderRadius: 6,
              padding: '2px 8px',
            }}
          >
            含电子签章 {doc.signatures.length} 处（未验签）
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {timing && (
            <span style={{ fontSize: 11, color: '#9ca3af' }} data-testid="ofd-timing">
              {(timing.bytes / 1024).toFixed(0)}KB · 解析 {timing.parseMs.toFixed(0)}ms · 首页绘制{' '}
              {timing.paintMs.toFixed(0)}ms
            </span>
          )}
          <button onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))} style={zoomButton}>
            −
          </button>
          <span style={{ fontSize: 12, color: '#4b5563', width: 44, textAlign: 'center' }}>
            {Math.round(zoom * 100)}%
          </span>
          <button onClick={() => setZoom((z) => Math.min(4, z + 0.25))} style={zoomButton}>
            +
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 0' }}>
        {doc === null ? (
          <p style={{ textAlign: 'center', color: '#6b7280', fontFamily: 'system-ui, sans-serif' }}>
            解析中…
          </p>
        ) : (
          doc.pages.map((page, index) => (
            <PageView
              key={index}
              doc={doc}
              page={page}
              index={index}
              zoom={zoom}
              dpr={dpr}
              imageCache={imageCache}
              onPainted={onPainted}
            />
          ))
        )}
      </div>
    </div>
  )
}

const zoomButton: React.CSSProperties = {
  width: 26,
  height: 22,
  borderRadius: 6,
  border: '1px solid #e2e5ea',
  background: '#fff',
  color: '#4b5563',
  cursor: 'pointer',
  lineHeight: 1,
}
