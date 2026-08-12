import { useEffect, useRef, useState } from 'react'
import { LOGO_SVG } from '../../branding'
import { wopiDisplayName } from '../../server-files'
import { OFFICE_ROUTES, officeHref } from '../../open-office-file'

/** coolwsd refuses some documents (host allowlist, no session slot) by
 * closing the socket — the frame then just sits empty. Give the editor this
 * long to paint before telling the user something is wrong. */
const EDITOR_READY_TIMEOUT_MS = 30_000

/**
 * Full-featured editing via Collabora Online — the complete LibreOffice
 * toolbar and feature set. The shell embeds the WOPI host's /edit page,
 * which iframes coolwsd through the host's same-origin /browser + /cool
 * proxy, so it works everywhere the shell itself does (LAN, tunnel,
 * public domain). Routes here: odt/ods/odp/doc/ppt/rtf, plus the
 * "完整工具栏" mode for the OOXML formats.
 */
export function CollaboraApp() {
  const query = window.location.hash.split('?')[1] ?? ''
  const src = new URLSearchParams(query).get('src') ?? ''
  const name = wopiDisplayName(src)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [stalled, setStalled] = useState(false)
  let token = ''
  try {
    token = new URL(src).searchParams.get('access_token') ?? ''
  } catch {
    // src without an access token still opens when the host has a dev token
  }

  // Poll for Collabora's own toolbar inside the nested (same-origin) frame;
  // its absence after the grace period means the session never started.
  useEffect(() => {
    if (!name) return
    const started = Date.now()
    const timer = window.setInterval(() => {
      const inner = frameRef.current?.contentDocument?.querySelector('iframe') as
        | HTMLIFrameElement
        | null
      const ready = Boolean(
        inner?.contentDocument?.querySelector('#toolbar-up, .notebookbar, #toolbar-wrapper'),
      )
      if (ready) {
        window.clearInterval(timer)
        setStalled(false)
      } else if (Date.now() - started > EDITOR_READY_TIMEOUT_MS) {
        window.clearInterval(timer)
        setStalled(true)
      }
    }, 1500)
    return () => window.clearInterval(timer)
  }, [name])

  const ext = (name ?? '').split('.').pop()?.toLowerCase() ?? ''
  const builtInRoute = OFFICE_ROUTES[ext]
  const hasBuiltIn = builtInRoute !== undefined && builtInRoute !== 'collabora'

  if (!name) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          color: '#6b7280',
        }}
      >
        无法识别文档来源 — 请从首页的服务器文件列表打开。
      </div>
    )
  }

  const frameSrc = `/edit/${encodeURIComponent(name)}?embed=1${
    token ? `&token=${encodeURIComponent(token)}` : ''
  }`
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
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
        <span
          className="notranslate"
          translate="no"
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            color: '#6b7280',
            border: '1px solid #e2e5ea',
            borderRadius: 6,
            padding: '2px 8px',
          }}
        >
          Collabora 完整编辑
        </span>
      </div>
      {stalled && (
        <div
          data-testid="collabora-stalled"
          style={{
            padding: '10px 14px',
            background: '#fff7ed',
            borderBottom: '1px solid #fed7aa',
            color: '#9a3412',
            font: '13px system-ui, sans-serif',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexShrink: 0,
          }}
        >
          <span>
            Collabora 编辑会话未能启动（协作服务拒绝了本站点或暂时不可用）。
          </span>
          {hasBuiltIn && (
            <a
              href={officeHref(builtInRoute, src)}
              style={{ color: '#2563eb', textDecoration: 'none', whiteSpace: 'nowrap' }}
            >
              用内置编辑器打开 →
            </a>
          )}
          <button
            onClick={() => window.location.reload()}
            style={{
              marginLeft: 'auto',
              padding: '3px 10px',
              fontSize: 12,
              borderRadius: 6,
              border: '1px solid #fed7aa',
              background: '#fff',
              color: '#9a3412',
              cursor: 'pointer',
            }}
          >
            重试
          </button>
        </div>
      )}
      <iframe
        ref={frameRef}
        src={frameSrc}
        title={name}
        allowFullScreen
        data-testid="collabora-frame"
        style={{ flex: 1, border: 0, width: '100%' }}
      />
    </div>
  )
}
