import { useEffect, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import App from './renderer/App'
import { LocaleProvider } from './renderer/i18n/locale'
import './renderer/styles.css'

/**
 * Mounts the ported pdf editor inside the shell. Replaces the upstream
 * Electron renderer entry (desktop/apps/pdf/src/renderer/main.tsx), which
 * rendered straight into #root: fetch the UI language through the bridge,
 * then boot App under its LocaleProvider.
 */
export function PdfApp() {
  const [lang, setLang] = useState<Lang | null>(null)
  useEffect(() => {
    let alive = true
    window.pdfApi
      .getLanguage()
      .catch(() => 'en' as const)
      .then((l) => {
        if (!alive) return
        document.documentElement.lang = l
        setLang(l)
      })
    return () => {
      alive = false
    }
  }, [])
  if (lang === null) return null
  return (
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>
  )
}
