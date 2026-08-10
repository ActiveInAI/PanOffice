import { useEffect, useRef, useState } from 'react'
import { installAccount, LoginPanel } from './account'
import { DocsApp } from './apps/docs/DocsApp'
import { PdfApp } from './apps/pdf/PdfApp'
import { SheetsApp } from './apps/sheets/SheetsApp'
import { SlidesApp } from './apps/slides/SlidesApp'
import { LOGO_SVG } from './branding'
import { platform } from './bridge/platform'

// Arch-GPT account (JWT SSO) — module scope; account.getAiApiKey() feeds the
// archgpt AI provider's apiKey. See src/account/README.md.
const account = installAccount()

/**
 * PanOffice Tauri shell — M2 (pdf) + docs.
 *
 * Hash routes:
 *   #/                 home placeholder
 *   #/pdf?src=<path>   the ported GenOffice pdf editor; the bridge hands the
 *                      src to the editor once via window.pdfApi.consumePending()
 *   #/docs?src=<path>  the ported GenOffice docs editor; src is consumed once
 *                      via window.desktop.consumePendingOpenDocx()
 *   #/sheets?src=<path>  the ported GenOffice sheets editor; the bridge's
 *                      window.desktopApi.selectWorkbook() consumes the src
 *                      once after SheetsApp fires the menu 'open' action
 *   #/slides?src=<path>  the ported GenOffice slides editor; the bridge's
 *                      window.slidesApi.consumePendingOpen() consumes the src
 *                      once (no src → a blank deck)
 *
 * Target shape (see ../docs/TAURI-MIGRATION.md): a tab strip hosting one
 * tab per open document. Tabs are iframes running the ported GenOffice
 * renderers (pdf first, then docs/sheets/slides); the renderers reach the
 * Rust backend through the window.* shims installed by src/bridge/.
 */

/** Track location.hash so route changes re-render the shell */
function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  return hash
}

/** file extension → editor route */
const OPEN_ROUTES: Record<string, string> = {
  pdf: 'pdf',
  docx: 'docs',
  xlsx: 'sheets',
  pptx: 'slides',
}

/** Open a local file from disk: bytes go into the platform byte-store, then
 * route to the matching editor. (Browser mode: IndexedDB overlay; Tauri:
 * same call hits the Rust file commands — see bridge/platform.ts.) */
function OpenLocalButton() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const onPick = async (file: File): Promise<void> => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const route = OPEN_ROUTES[ext]
    if (!route) {
      alert(`unsupported file type: .${ext} (pdf/docx/xlsx/pptx)`)
      return
    }
    setBusy(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const key = `local/${file.name.replace(/^.*[\\/]/, '')}`
      await platform.writeFile(key, bytes)
      window.location.hash = `#/${route}?src=${encodeURIComponent(key)}`
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={{ margin: '12px 0 20px' }}>
      <input
        ref={inputRef}
        type="file"
        hidden
        accept=".pdf,.docx,.xlsx,.pptx"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onPick(f)
          e.target.value = ''
        }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        style={{
          padding: '8px 18px',
          fontSize: 14,
          borderRadius: 8,
          border: '1px solid #d0d3d8',
          background: '#fff',
          cursor: 'pointer',
        }}
      >
        {busy ? 'Opening…' : '打开本地文件… (pdf / docx / xlsx / pptx)'}
      </button>
    </div>
  )
}

function Home() {
  const [tabs] = useState([{ id: 'home', title: 'PanOffice' }])
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', margin: 0 }}>
      <nav
        style={{
          display: 'flex',
          gap: 4,
          padding: '6px 8px',
          background: '#f3f4f6',
          borderBottom: '1px solid #e5e7eb',
          alignItems: 'center',
        }}
      >
        <img src={LOGO_SVG} alt="" width={20} height={20} style={{ marginRight: 4 }} />
        {tabs.map((t) => (
          <span
            key={t.id}
            style={{
              padding: '4px 14px',
              borderRadius: 6,
              background: '#fff',
              border: '1px solid #e5e7eb',
              fontSize: 13,
            }}
          >
            {t.title}
          </span>
        ))}
      </nav>
      <main style={{ padding: 24 }}>
        <h1 style={{ fontSize: 22, display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src={LOGO_SVG} alt="PanOffice" width={36} height={36} />
          PanOffice
        </h1>
        <p>
          Tauri shell (M2). The pdf editor is ported — open{' '}
          <a href="#/pdf?src=/fixtures/hello.pdf">#/pdf?src=/fixtures/hello.pdf</a> for the fixture
          document. The docs editor is in — open{' '}
          <a href="#/docs?src=/fixtures/simple.docx">#/docs?src=/fixtures/simple.docx</a>. The
          sheets editor is in — open{' '}
          <a href="#/sheets?src=/fixtures/hello.xlsx">#/sheets?src=/fixtures/hello.xlsx</a>. The
          slides editor is in — open{' '}
          <a href="#/slides?src=/fixtures/hello.pptx">#/slides?src=/fixtures/hello.pptx</a>. Web
          collaboration runs through the Collabora Online stack in <code>deploy/</code>.
        </p>
        <OpenLocalButton />
        <LoginPanel account={account} />
      </main>
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
