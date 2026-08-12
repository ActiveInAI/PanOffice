const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const LOCAL_FILES_ORIGIN = 'http://127.0.0.1:3210'

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * Resolve the file-service base without making a web-opened PanOffice page call
 * the viewer's own localhost. Web shells always default to their own origin so
 * the production proxy and Vite dev proxy can route files consistently. Native
 * Tauri keeps using the explicitly local 3210 service.
 */
export function resolveFilesBase(
  configured: string | null,
  pageHref: string,
  nativeTauri = false,
): string {
  let page: URL | null = null
  try {
    page = new URL(pageHref)
  } catch {
    // A malformed page URL can only occur in a non-browser test/runtime.
  }

  const webOrigin =
    page !== null && !nativeTauri && /^https?:$/.test(page.protocol)
      ? page.origin
      : null
  const fallback = webOrigin ?? LOCAL_FILES_ORIGIN

  const raw = configured?.trim()
  if (!raw) return withoutTrailingSlash(fallback)

  try {
    const candidate = new URL(raw, fallback)
    const staleWebLoopback =
      webOrigin !== null &&
      LOOPBACK_HOSTS.has(candidate.hostname) &&
      candidate.port === '3210' &&
      candidate.origin !== webOrigin
    if (staleWebLoopback) {
      return withoutTrailingSlash(fallback)
    }
    return withoutTrailingSlash(candidate.toString())
  } catch {
    return withoutTrailingSlash(fallback)
  }
}

/**
 * WOPI listings may contain an absolute deployment URL. Web shells route that
 * URL back through their selected file-service origin so local development and
 * public-domain access stay same-origin. Native Tauri retains the server URL.
 */
export function resolveServerContentUrl(
  contentUrl: string,
  filesBase: string,
  nativeTauri = false,
): string {
  if (nativeTauri) return contentUrl
  try {
    const base = new URL(filesBase)
    const content = new URL(contentUrl, base)
    if (!/^https?:$/.test(base.protocol) || !/^https?:$/.test(content.protocol)) {
      return contentUrl
    }
    return `${base.origin}${content.pathname}${content.search}${content.hash}`
  } catch {
    return contentUrl
  }
}
