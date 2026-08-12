import { useCallback, useEffect, useRef, useState } from 'react'
import { platform } from '../../bridge/platform'
import { LOGO_SVG } from '../../branding'
import { wopiDisplayName } from '../../server-files'

/**
 * Plain-text editor for txt/xml (and anything text-like routed here).
 * Reads through the shared byte store (server-first for `local/` keys,
 * WOPI PutFile for remote sources), decodes UTF-8 with a GB18030 fallback
 * for legacy Chinese files, and always saves back as UTF-8.
 */

function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' }
  } catch {
    // Legacy mainland-China text files are overwhelmingly GB18030/GBK.
    return { text: new TextDecoder('gb18030').decode(bytes), encoding: 'GB18030' }
  }
}

export function TextApp() {
  const query = window.location.hash.split('?')[1] ?? ''
  const src = new URLSearchParams(query).get('src') ?? ''
  const name = wopiDisplayName(src) ?? src.split(/[\\/]/).pop() ?? src
  const [text, setText] = useState<string | null>(null)
  const [status, setStatus] = useState('载入中…')
  const [dirty, setDirty] = useState(false)
  const textRef = useRef('')

  useEffect(() => {
    let alive = true
    if (!src) {
      setStatus('无法识别文档来源')
      return
    }
    platform
      .readFile(src)
      .then((bytes) => {
        if (!alive) return
        const decoded = decodeText(bytes)
        textRef.current = decoded.text
        setText(decoded.text)
        setStatus(
          `已打开（${decoded.encoding}${decoded.encoding === 'GB18030' ? '，保存后转为 UTF-8' : ''}）`,
        )
      })
      .catch((error: unknown) => {
        if (!alive) return
        setStatus(error instanceof Error ? error.message : '读取失败')
      })
    return () => {
      alive = false
    }
  }, [src])

  const save = useCallback(async () => {
    if (text === null) return
    setStatus('保存中…')
    try {
      await platform.writeFile(src, new TextEncoder().encode(textRef.current))
      setDirty(false)
      setStatus('已保存（UTF-8）')
    } catch (error) {
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [src, text])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

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
          {dirty ? ' •' : ''}
        </span>
        <button
          onClick={() => void save()}
          disabled={text === null || !dirty}
          data-testid="text-save"
          style={{
            marginLeft: 'auto',
            padding: '4px 14px',
            fontSize: 13,
            borderRadius: 6,
            border: '1px solid #e2e5ea',
            background: dirty ? '#2563eb' : '#fff',
            color: dirty ? '#fff' : '#6b7280',
            cursor: 'pointer',
          }}
        >
          保存 (Ctrl+S)
        </button>
        <span style={{ fontSize: 12, color: '#6b7280' }}>{status}</span>
      </div>
      <textarea
        value={text ?? ''}
        readOnly={text === null}
        data-testid="text-editor"
        spellCheck={false}
        onChange={(event) => {
          textRef.current = event.target.value
          setText(event.target.value)
          setDirty(true)
        }}
        style={{
          flex: 1,
          border: 0,
          outline: 'none',
          resize: 'none',
          padding: '14px 16px',
          font: '14px/1.6 ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace',
          color: '#111827',
          background: '#ffffff',
          whiteSpace: 'pre',
          overflowWrap: 'normal',
          overflowX: 'auto',
        }}
      />
    </div>
  )
}
