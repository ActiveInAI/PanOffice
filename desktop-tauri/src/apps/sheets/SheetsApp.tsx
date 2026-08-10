import { useEffect, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import { emitSheetsMenuAction } from '../../bridge/sheets-api'
import { App } from './renderer/App'
import { LocaleProvider, setModuleLang } from './renderer/i18n/locale'
import '@univerjs/preset-sheets-core/lib/index.css'
import './renderer/styles.css'

/**
 * Mounts the ported sheets editor inside the shell. Replaces the upstream
 * Electron renderer entry (desktop/apps/sheets/src/renderer/main.tsx), which
 * rendered straight into #root: fetch the UI language through the bridge,
 * mirror it to the module-level translator, boot App under its LocaleProvider,
 * then route a pending `#/sheets?src=…` into the renderer's open flow as a
 * menu 'open' action (the bridge's selectWorkbook consumes the src).
 */
export function SheetsApp() {
  const [lang, setLang] = useState<Lang | null>(null)
  useEffect(() => {
    let alive = true
    window.desktopApi
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
  useEffect(() => {
    if (lang === null) return
    const query = window.location.hash.split('?')[1] ?? ''
    if (!new URLSearchParams(query).get('src')) return
    // The renderer starts blank and opens files via the menu action; queue the
    // open once (the bridge holds it until the handler subscribes).
    emitSheetsMenuAction('open')
  }, [lang])
  if (lang === null) return null
  return (
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>
  )
}
