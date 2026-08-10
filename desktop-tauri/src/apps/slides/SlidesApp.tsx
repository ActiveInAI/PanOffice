import { useEffect, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import { App } from './renderer/App'
import { LocaleProvider, setModuleLang } from './renderer/i18n/locale'
import './renderer/styles.css'

/**
 * Mounts the ported slides editor inside the shell. Replaces the upstream
 * Electron renderer entry (desktop/apps/slides/src/renderer/main.tsx), which
 * rendered straight into #root: fetch the UI language through the bridge,
 * mirror it to the module-level translator, then boot App under its
 * LocaleProvider. On mount the renderer pulls `#/slides?src=…` once via
 * window.slidesApi.consumePendingOpen() (no src → a blank deck).
 *
 * The upstream `?mode=audience` window (presenter show's second screen) is not
 * ported — the presenter surface is stubbed in the bridge (TODO M4).
 */
export function SlidesApp() {
  const [lang, setLang] = useState<Lang | null>(null)
  useEffect(() => {
    let alive = true
    window.slidesApi
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
