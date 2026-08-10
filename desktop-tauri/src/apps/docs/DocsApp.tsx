import { useEffect, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import { App } from './renderer/App'
import { LocaleProvider, setModuleLang } from './renderer/i18n/locale'
import './renderer/styles.css'
import './renderer/fonts/fonts.css'

/**
 * Mounts the ported docs editor inside the shell. Replaces the upstream
 * Electron renderer entry (desktop/apps/docs/src/renderer/main.tsx), which
 * rendered straight into #root: fetch the UI language through the bridge,
 * mirror it to the module-level translator, then boot App under its
 * LocaleProvider.
 */
export function DocsApp() {
  const [lang, setLang] = useState<Lang | null>(null)
  useEffect(() => {
    let alive = true
    window.desktop
      .getLanguage()
      .catch(() => 'en' as const)
      .then((l) => {
        if (!alive) return
        document.documentElement.lang = l
        setModuleLang(l)
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
