import { useEffect, useRef, useState } from 'react'
import { DocsApp } from './apps/docs/DocsApp'
import { PdfApp } from './apps/pdf/PdfApp'
import { SheetsApp } from './apps/sheets/SheetsApp'
import { SlidesApp } from './apps/slides/SlidesApp'
import { LOGO_SVG } from './branding'
import { isTauri, platform } from './bridge/platform'
import { makeBlankDocx, makeBlankPdf, makeBlankXlsx } from './blank-docs'
import {
  OFFICE_FILE_ACCEPT,
  OFFICE_ROUTES as OPEN_ROUTES,
  openOfficeFile,
} from './open-office-file'
import {
  loadRecents,
  persistRecents,
  pushRecent,
  removeRecent,
  type RecentEntry,
} from './recent-files'
import {
  resolveFilesBase,
  resolveServerContentUrl,
  resolveServerDeleteUrl,
} from './server-files'

/**
 * PanOffice Tauri shell — unified on the GenOffice editors (M8).
 * Home follows the upstream suite layout: left nav, greeting, new/open
 * cards, then the server file list and the recent-files list.
 *
 * Hash routes:
 *   #/                 home (new/open/server/recent files)
 *   #/pdf?src=<path>   pdf editor     (src consumed once via window.pdfApi.consumePending)
 *   #/docs?src=<path>  docs editor    (via window.desktop.consumePendingOpenDocx)
 *   #/sheets?src=<path> sheets editor (via window.desktopApi.selectWorkbook)
 *   #/slides?src=<path> slides editor (via window.slidesApi.consumePendingOpen; no src → blank deck)
 *
 * A `src` may be a local/overlay path or a remote WOPI contents URL
 * (http(s)://…/wopi/files/<name>/contents?access_token=…).
 */

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  return hash
}

const TYPE_META: Record<string, { label: string; zh: string; bg: string; fg: string }> = {
  docx: { label: 'W', zh: '文档', bg: '#e9f2fb', fg: '#185abd' },
  xlsx: { label: 'X', zh: '表格', bg: '#e6f2eb', fg: '#107c41' },
  pptx: { label: 'P', zh: '演示', bg: '#fcece7', fg: '#d24726' },
  pdf: { label: 'PDF', zh: 'PDF', bg: '#f3f2f1', fg: '#605e5c' },
}

interface ServerFile {
  name: string
  size: number
  mtimeMs: number
  contentUrl?: string
}

function filesBase(): string {
  return resolveFilesBase(
    localStorage.getItem('panoffice.filesUrl'),
    window.location.href,
    isTauri(),
  )
}

function wopiToken(): string {
  return localStorage.getItem('panoffice.wopiToken') ?? 'devtoken'
}

function serverFileHref(name: string, contentUrl?: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const route = OPEN_ROUTES[ext]
  if (!route) return null
  const base = filesBase()
  const src = contentUrl
    ? resolveServerContentUrl(contentUrl, base, isTauri())
    : `${base}/wopi/files/${encodeURIComponent(name)}/contents?access_token=${encodeURIComponent(wopiToken())}`
  return `#/${route}?src=${encodeURIComponent(src)}`
}

function navigateOfficeHref(href: string): void {
  window.location.hash = href
  // Each editor's pending-source guard is module scoped; reload so repeated
  // cross-format opens always consume the newly selected source.
  window.location.reload()
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 18) return '下午好'
  return '晚上好'
}

// ---- shared style atoms ----

const card: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e8eaee',
  borderRadius: 14,
  boxShadow: '0 1px 3px rgba(16,24,40,0.06)',
}

/** Office 365 color language for cards and file rows; PDF is an original
 * three-spoke mark built from the Word/Excel/PowerPoint brand colors. */
function TypeTile({ ext, size = 44 }: { ext: string; size?: number }) {
  const meta = TYPE_META[ext] ?? { label: ext.slice(0, 3).toUpperCase() || '?', bg: '#eef0f3', fg: '#6b7280' }
  const mark = (() => {
    if (ext === 'pdf') {
      return (
        <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
          <circle cx="24" cy="24" r="19" fill="#ffffff" stroke="#d2d0ce" />
          <path d="M24 24 24 5a19 19 0 0 1 16.45 28.5Z" fill="#185abd" stroke="#fff" strokeWidth="1.8" />
          <path d="M24 24 40.45 33.5A19 19 0 0 1 7.55 33.5Z" fill="#107c41" stroke="#fff" strokeWidth="1.8" />
          <path d="M24 24 7.55 33.5A19 19 0 0 1 24 5Z" fill="#d24726" stroke="#fff" strokeWidth="1.8" />
          <circle cx="24" cy="24" r="7" fill="#fff" stroke="#d2d0ce" strokeWidth="1.2" />
        </svg>
      )
    }
    if (ext === 'docx') {
      return (
        <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
          <rect x="12" y="5" width="31" height="38" rx="5" fill="#fff" />
          <path d="M31 12h8M31 18h8M31 24h8M31 30h8M31 36h8" stroke="#8ab7e5" strokeWidth="2" />
          <rect x="4" y="11" width="28" height="30" rx="5" fill="#185abd" />
          <text x="18" y="32" fill="#fff" fontFamily="Segoe UI, sans-serif" fontSize="20" fontWeight="700" textAnchor="middle">W</text>
        </svg>
      )
    }
    if (ext === 'xlsx') {
      return (
        <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
          <rect x="12" y="5" width="31" height="38" rx="5" fill="#fff" />
          <path d="M30 11h10M30 18h10M30 25h10M30 32h10M35 8v28" stroke="#75b597" strokeWidth="2" />
          <rect x="4" y="11" width="28" height="30" rx="5" fill="#107c41" />
          <text x="18" y="32" fill="#fff" fontFamily="Segoe UI, sans-serif" fontSize="20" fontWeight="700" textAnchor="middle">X</text>
        </svg>
      )
    }
    if (ext === 'pptx') {
      return (
        <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
          <rect x="12" y="5" width="31" height="38" rx="5" fill="#fff" />
          <circle cx="34.5" cy="23" r="8.5" fill="#f3a58f" />
          <path d="M34.5 14.5v8.5H43a8.5 8.5 0 0 0-8.5-8.5Z" fill="#d24726" />
          <rect x="4" y="11" width="28" height="30" rx="5" fill="#d24726" />
          <text x="18" y="32" fill="#fff" fontFamily="Segoe UI, sans-serif" fontSize="20" fontWeight="700" textAnchor="middle">P</text>
        </svg>
      )
    }
    return <span style={{ color: meta.fg }}>{meta.label}</span>
  })()
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: Math.max(6, size / 7),
        background: meta.bg,
        color: meta.fg,
        fontWeight: 700,
        fontSize: size * 0.42,
        flexShrink: 0,
        boxShadow: 'inset 0 0 0 1px rgba(96,94,92,0.08)',
        overflow: 'hidden',
      }}
    >
      {mark}
    </span>
  )
}

function DeleteIconButton({
  label,
  title,
  testId,
  disabled = false,
  onClick,
}: {
  label: string
  title: string
  testId: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'grid',
        placeItems: 'center',
        width: 28,
        height: 28,
        padding: 0,
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: '#8a909c',
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
      }}
      onMouseEnter={(event) => {
        if (disabled) return
        event.currentTarget.style.background = '#feeceb'
        event.currentTarget.style.color = '#c42b1c'
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent'
        event.currentTarget.style.color = '#8a909c'
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M4 7h16" />
        <path d="M9 7V4h6v3" />
        <path d="m6 7 1 13h10l1-13" />
        <path d="M10 11v5M14 11v5" />
      </svg>
    </button>
  )
}

// ---- new-document cards ----

interface NewCard {
  ext: string
  title: string
  make: (() => Promise<Uint8Array>) | null // null → the route handles blank itself
}

const NEW_CARDS: NewCard[] = [
  { ext: 'docx', title: '新建文档', make: makeBlankDocx },
  { ext: 'xlsx', title: '新建表格', make: makeBlankXlsx },
  { ext: 'pptx', title: '新建演示', make: makeBlankPptx },
  { ext: 'pdf', title: '新建 PDF', make: makeBlankPdf },
]

async function makeBlankPptx(): Promise<Uint8Array> {
  throw new Error('handled-by-route')
}

function NewDocCards({ onOpenLocal }: { onOpenLocal: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const create = async (c: NewCard): Promise<void> => {
    setBusy(c.ext)
    try {
      if (c.make === null || c.ext === 'pptx') {
        // slides editor handles "no src" as a blank deck
        navigateOfficeHref('#/slides')
        return
      }
      const bytes = await c.make()
      const key = `local/未命名.${c.ext}`
      await platform.writeFile(key, bytes)
      // Reload after changing formats so the bridge's one-shot pending-source
      // guard is reset. Without this, returning from an earlier PDF session
      // and creating another PDF leaves the editor with no consumed source.
      navigateOfficeHref(`#/${OPEN_ROUTES[c.ext]}?src=${encodeURIComponent(key)}`)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '18px 0 22px' }}>
      {NEW_CARDS.map((c) => (
        <button
          key={c.ext}
          data-testid={`new-${c.ext}`}
          onClick={() => void create(c)}
          disabled={busy !== null}
          style={{
            ...card,
            width: 170,
            padding: '18px 16px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 12,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <TypeTile ext={c.ext} />
          <span style={{ fontSize: 14, fontWeight: 600, color: '#1f2329' }}>
            {busy === c.ext ? '创建中…' : c.title}
          </span>
          <span style={{ fontSize: 12, color: '#9aa0ab' }}>.{c.ext}</span>
        </button>
      ))}
      <button
        data-testid="open-local-card"
        onClick={onOpenLocal}
        style={{
          ...card,
          width: 170,
          padding: '18px 16px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 12,
          cursor: 'pointer',
          textAlign: 'left',
          borderStyle: 'dashed',
        }}
      >
        <span
          style={{
            width: 44,
            height: 44,
            borderRadius: 8,
            background: '#eef0f3',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
          }}
        >
          📂
        </span>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#1f2329' }}>打开本地文件</span>
        <span style={{ fontSize: 12, color: '#9aa0ab' }}>.docx / .xlsx / .pptx / .pdf</span>
      </button>
    </div>
  )
}

// ---- server files ----

function ServerFiles({
  onOpened,
  onFilesLoaded,
  onDeleted,
}: {
  onOpened: (e: Omit<RecentEntry, 'ts'>) => void
  onFilesLoaded: (files: ServerFile[]) => void
  onDeleted: (file: ServerFile) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<ServerFile[] | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch(`${filesBase()}/files.json`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const loaded = (await res.json()) as ServerFile[]
      setFiles(loaded)
      onFilesLoaded(loaded)
      setUnreachable(false)
    } catch {
      setFiles(null)
      setUnreachable(true)
    }
  }
  useEffect(() => {
    void refresh()
  }, [])

  const officeFiles = files?.filter((file) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    return OPEN_ROUTES[ext] !== undefined
  }) ?? null

  const onUpload = async (file: File): Promise<void> => {
    setBusy(true)
    try {
      const res = await fetch(`${filesBase()}/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await refresh()
    } catch (err) {
      alert(`upload failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (file: ServerFile): Promise<void> => {
    const confirmed = window.confirm(
      `确定要从服务器删除“${file.name}”吗？此操作无法在 PanOffice 中撤销。`,
    )
    if (!confirmed) return

    setDeleting(file.name)
    try {
      const url = resolveServerDeleteUrl(
        file.name,
        file.contentUrl,
        filesBase(),
        wopiToken(),
        isTauri(),
      )
      const res = await fetch(url, { method: 'DELETE' })
      if (!res.ok) {
        if (res.status === 403) throw new Error('当前账号没有删除此文件的权限。')
        if (res.status === 409) throw new Error('文件正在编辑或已锁定，请关闭编辑器后重试。')
        if (res.status === 404) throw new Error('文件已不存在，请刷新列表。')
        throw new Error(`服务器返回 HTTP ${res.status}`)
      }
      onDeleted(file)
      await refresh()
    } catch (error) {
      alert(`删除失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setDeleting(null)
    }
  }

  return (
    <section data-testid="server-files" style={{ ...card, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>服务器文件</h2>
        <span style={{ fontSize: 12, color: '#8a909c' }}>{filesBase()}</span>
        {officeFiles && (
          <span style={{ fontSize: 12, color: '#8a909c' }}>{officeFiles.length} 个办公文件</span>
        )}
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          style={{
            marginLeft: 'auto',
            padding: '6px 14px',
            fontSize: 13,
            borderRadius: 8,
            border: '1px solid #e2e5ea',
            background: '#fff',
            cursor: 'pointer',
          }}
        >
          {busy ? '上传中…' : '上传'}
        </button>
      </div>
      {unreachable && (
        <p style={{ color: '#b45309', fontSize: 13, margin: '0 0 6px' }}>
          文件服务暂不可用（{filesBase()}），请确认当前 PanOffice 服务已启用文件目录。
        </p>
      )}
      {officeFiles && officeFiles.length === 0 && (
        <p style={{ color: '#8a909c', fontSize: 13, margin: '2px 0' }}>
          暂无 Word、Excel、PPT 或 PDF 文件。
        </p>
      )}
      {officeFiles && officeFiles.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            maxHeight: 300,
            overflowY: 'auto',
          }}
        >
          {officeFiles.map((f) => {
            const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
            const href = serverFileHref(f.name, f.contentUrl)
            return (
              <li
                key={f.name}
                style={{ display: 'flex', alignItems: 'center', borderRadius: 8 }}
                onMouseEnter={(event) => (event.currentTarget.style.background = '#f6f7f9')}
                onMouseLeave={(event) => (event.currentTarget.style.background = 'transparent')}
              >
                <a
                  href={href ?? '#'}
                  onClick={(event) => {
                    if (!href) return
                    event.preventDefault()
                    onOpened({
                      key: `server:${f.name}`,
                      name: f.name,
                      ext,
                      contentUrl: f.contentUrl,
                    })
                    navigateOfficeHref(href)
                  }}
                  style={{
                    display: 'flex',
                    flex: 1,
                    minWidth: 0,
                    alignItems: 'center',
                    gap: 12,
                    padding: '7px 8px',
                    borderRadius: 8,
                    textDecoration: 'none',
                    color: href ? '#1f2329' : '#8a909c',
                  }}
                >
                  <TypeTile ext={ext} size={30} />
                  <span style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.name}
                  </span>
                </a>
                <DeleteIconButton
                  label={`从服务器删除 ${f.name}`}
                  title="从服务器删除"
                  testId="server-file-delete"
                  disabled={deleting === f.name}
                  onClick={() => void onDelete(f)}
                />
                <span style={{ width: 190, paddingRight: 8, textAlign: 'right', fontSize: 12, color: '#9aa0ab' }}>
                  {formatDate(f.mtimeMs)} · {formatSize(f.size)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <input
        ref={inputRef}
        type="file"
        hidden
        data-testid="server-upload-input"
        accept={OFFICE_FILE_ACCEPT}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onUpload(f)
          e.target.value = ''
        }}
      />
    </section>
  )
}

// ---- recents ----

function Recents({
  recents,
  onOpen,
  onRemove,
}: {
  recents: RecentEntry[]
  onOpen: (r: RecentEntry) => void
  onRemove: (r: RecentEntry) => void
}) {
  const [filter, setFilter] = useState('全部')
  const tabs = ['全部', '文档', '表格', '演示', 'PDF']
  const extOfTab: Record<string, string> = { 文档: 'docx', 表格: 'xlsx', 演示: 'pptx', PDF: 'pdf' }
  const shown = recents.filter((r) => filter === '全部' || r.ext === extOfTab[filter])
  return (
    <section style={{ marginTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>最近使用</h2>
        <span style={{ fontSize: 12, color: '#8a909c' }}>{recents.length} 个文件</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              style={{
                padding: '4px 12px',
                fontSize: 12,
                borderRadius: 7,
                border: '1px solid',
                borderColor: filter === t ? '#e5b93a' : '#e2e5ea',
                background: filter === t ? '#fdf3d7' : '#fff',
                cursor: 'pointer',
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <div style={{ ...card, padding: '40px 0', textAlign: 'center', color: '#9aa0ab', fontSize: 13 }}>
          暂无最近文件 — 新建或打开一个文件开始使用。
        </div>
      ) : (
        <ul style={{ ...card, listStyle: 'none', padding: '6px 10px', margin: 0 }}>
          {shown.map((r) => {
            const href = r.key.startsWith('server:')
              ? (serverFileHref(r.name, r.contentUrl) ?? '#')
              : `#/${OPEN_ROUTES[r.ext]}?src=${encodeURIComponent(r.key)}`
            return (
            <li
              key={r.key}
              style={{ display: 'flex', alignItems: 'center', borderRadius: 8 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f6f7f9')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault()
                  onOpen(r)
                  navigateOfficeHref(href)
                }}
                style={{
                  display: 'flex',
                  flex: 1,
                  minWidth: 0,
                  alignItems: 'center',
                  gap: 12,
                  padding: '7px 8px',
                  borderRadius: 8,
                  textDecoration: 'none',
                  color: '#1f2329',
                }}
              >
                <TypeTile ext={r.ext} size={30} />
                <span style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.name}
                </span>
              </a>
              <DeleteIconButton
                label={`从最近使用中移除 ${r.name}`}
                title="从最近使用中移除"
                testId="recent-remove"
                onClick={() => onRemove(r)}
              />
              <span style={{ width: 128, paddingRight: 8, textAlign: 'right', fontSize: 12, color: '#9aa0ab' }}>
                {formatDate(r.ts)}
              </span>
            </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ---- home ----

type HomeNavIconName = 'back' | 'home' | 'new' | 'open' | 'server' | 'recent'

function HomeNavIcon({ name }: { name: HomeNavIconName }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (name === 'back') {
    return <svg {...common}><path d="M15 18l-6-6 6-6" /><path d="M9 12h10" /></svg>
  }
  if (name === 'home') {
    return <svg {...common}><path d="M3.5 10.5 12 3l8.5 7.5" /><path d="M5.5 9.5V21h13V9.5" /><path d="M9.5 21v-7h5v7" /></svg>
  }
  if (name === 'new') {
    return <svg {...common}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /><path d="M12 11v6M9 14h6" /></svg>
  }
  if (name === 'open') {
    return <svg {...common}><path d="M3 7h7l2 2h9l-2.5 10H4.5z" /><path d="M3 7v12" /></svg>
  }
  if (name === 'server') {
    return <svg {...common}><rect x="4" y="4" width="16" height="6" rx="1.5" /><rect x="4" y="14" width="16" height="6" rx="1.5" /><path d="M8 7h.01M8 17h.01M12 7h5M12 17h5" /></svg>
  }
  return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
}

function HomeNavButton({
  icon,
  label,
  active = false,
  onClick,
  testId,
}: {
  icon: HomeNavIconName
  label: string
  active?: boolean
  onClick: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      style={{
        width: '100%',
        height: 40,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 12px',
        border: 0,
        borderRadius: 8,
        background: active ? '#fdf3d7' : 'transparent',
        color: active ? '#5b4610' : '#343943',
        fontSize: 14,
        fontWeight: active ? 650 : 500,
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <HomeNavIcon name={icon} />
      <span>{label}</span>
    </button>
  )
}

function Home() {
  const [recents, setRecents] = useState<RecentEntry[]>(loadRecents)
  const localInputRef = useRef<HTMLInputElement>(null)
  const [opening, setOpening] = useState(false)
  const [activeNav, setActiveNav] = useState('home')
  const homeRef = useRef<HTMLElement>(null)
  const newRef = useRef<HTMLElement>(null)
  const serverRef = useRef<HTMLDivElement>(null)
  const recentRef = useRef<HTMLDivElement>(null)

  const goTo = (
    key: string,
    ref: React.RefObject<HTMLElement | HTMLDivElement | null>,
  ): void => {
    setActiveNav(key)
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const remember = (e: Omit<RecentEntry, 'ts'>): void => setRecents(pushRecent(e))
  const forgetKey = (key: string): void => {
    setRecents((current) => {
      const next = removeRecent(current, key)
      persistRecents(next)
      return next
    })
  }
  const forget = (entry: RecentEntry): void => forgetKey(entry.key)
  const forgetServerFile = (file: ServerFile): void => forgetKey(`server:${file.name}`)

  const syncServerSources = (files: ServerFile[]): void => {
    const urls = new Map(files.map((file) => [file.name, file.contentUrl]))
    setRecents((current) => {
      let changed = false
      const next = current.map((entry) => {
        if (!entry.key.startsWith('server:')) return entry
        const contentUrl = urls.get(entry.name)
        if (!contentUrl || contentUrl === entry.contentUrl) return entry
        changed = true
        return { ...entry, contentUrl }
      })
      return changed ? next : current
    })
  }

  const onPickLocal = async (file: File): Promise<void> => {
    setOpening(true)
    try {
      await openOfficeFile(file)
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error))
    } finally {
      setOpening(false)
    }
  }

  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        margin: 0,
        display: 'flex',
        minHeight: '100vh',
        background: '#f6f7f9',
      }}
    >
      <aside
        style={{
          width: 196,
          height: '100vh',
          position: 'sticky',
          top: 0,
          flexShrink: 0,
          background: '#fff',
          borderRight: '1px solid #e8eaee',
          display: 'flex',
          flexDirection: 'column',
          padding: '12px 10px',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px 12px' }}>
          <img src={LOGO_SVG} alt="" width={26} height={26} />
          <span style={{ fontSize: 16, fontWeight: 650 }}>PanOffice</span>
        </div>
        <HomeNavButton
          icon="back"
          label="返回"
          testId="home-nav-back"
          onClick={() => {
            if (window.history.length > 1) window.history.back()
            else goTo('home', homeRef)
          }}
        />
        <div style={{ height: 1, background: '#e8eaee', margin: '8px 8px' }} />
        <HomeNavButton icon="home" label="开始" active={activeNav === 'home'} testId="home-nav-home" onClick={() => goTo('home', homeRef)} />
        <HomeNavButton icon="new" label="新建" active={activeNav === 'new'} testId="home-nav-new" onClick={() => goTo('new', newRef)} />
        <HomeNavButton icon="open" label="打开" active={activeNav === 'open'} testId="home-nav-open" onClick={() => { setActiveNav('open'); localInputRef.current?.click() }} />
        <div style={{ height: 1, background: '#e8eaee', margin: '8px 8px' }} />
        <HomeNavButton icon="server" label="服务器文件" active={activeNav === 'server'} testId="home-nav-server" onClick={() => goTo('server', serverRef)} />
        <HomeNavButton icon="recent" label="最近使用" active={activeNav === 'recent'} testId="home-nav-recent" onClick={() => goTo('recent', recentRef)} />
      </aside>

      <main
        ref={homeRef}
        style={{
          flex: 1,
          width: '100%',
          maxWidth: 1120,
          padding: '30px 34px 54px',
          boxSizing: 'border-box',
          scrollMarginTop: 20,
        }}
      >
        <h1 style={{ fontSize: 26, margin: '0 0 4px' }}>{greeting()}。</h1>
        <p style={{ fontSize: 15, color: '#4b5563', margin: 0 }}>今天从哪里开始？</p>

        <section ref={newRef} style={{ scrollMarginTop: 20 }}>
          <NewDocCards onOpenLocal={() => localInputRef.current?.click()} />
        </section>
        {opening && <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 8px' }}>打开中…</p>}

        <div ref={serverRef} style={{ scrollMarginTop: 20 }}>
          <ServerFiles
            onOpened={remember}
            onFilesLoaded={syncServerSources}
            onDeleted={forgetServerFile}
          />
        </div>

        <div ref={recentRef} style={{ scrollMarginTop: 20 }}>
          <Recents recents={recents} onOpen={remember} onRemove={forget} />
        </div>
      </main>

      <input
        ref={localInputRef}
        type="file"
        hidden
        data-testid="open-local-input"
        accept={OFFICE_FILE_ACCEPT}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onPickLocal(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}

export function App() {
  const hash = useHashRoute()
  const route = hash.split('?')[0] ?? ''
  if (route === '#/pdf') return <PdfApp />
  if (route === '#/docs') return <DocsApp />
  if (route === '#/sheets') return <SheetsApp />
  if (route === '#/slides') return <SlidesApp />
  return <Home />
}
