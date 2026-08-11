const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const LOCAL_FILES_ORIGIN = 'http://127.0.0.1:3210'

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * Resolve the file-service base without making a remotely opened PanOffice page
 * call the viewer's own localhost. Native Tauri and local Vite development keep
 * using the local 3210 service; a remotely served shell defaults to its origin.
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

  const localWebDev =
    page !== null && LOOPBACK_HOSTS.has(page.hostname) && page.port !== '3210'
  const fallback = nativeTauri || page === null || !/^https?:$/.test(page.protocol) || localWebDev
    ? LOCAL_FILES_ORIGIN
    : page.origin

  const raw = configured?.trim()
  if (!raw) return withoutTrailingSlash(fallback)

  try {
    const candidate = new URL(raw, fallback)
    const remotePage = page !== null && !LOOPBACK_HOSTS.has(page.hostname)
    if (remotePage && LOOPBACK_HOSTS.has(candidate.hostname)) {
      return withoutTrailingSlash(fallback)
    }
    return withoutTrailingSlash(candidate.toString())
  } catch {
    return withoutTrailingSlash(fallback)
  }
}
