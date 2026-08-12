import { isTauri, platform } from './bridge/platform'
import { resetPendingDocumentSource } from './bridge/desktop-api'
import { resetPendingPdfSource } from './bridge/pdf-api'
import { resetPendingWorkbookSource } from './bridge/sheets-api'
import { resetPendingSlidesSource } from './bridge/slides-api'
import { pushRecent, type RecentEntry } from './recent-files'
import { resolveFilesBase, resolveServerContentUrl } from './server-files'

export const OFFICE_FILE_ACCEPT = '.docx,.xlsx,.pptx,.pdf'

export const OFFICE_ROUTES: Readonly<Record<string, 'docs' | 'sheets' | 'slides' | 'pdf'>> = {
  docx: 'docs',
  xlsx: 'sheets',
  pptx: 'slides',
  pdf: 'pdf',
}

function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

function filesBase(): string {
  return resolveFilesBase(
    localStorage.getItem('panoffice.filesUrl'),
    window.location.href,
    isTauri(),
  )
}

/**
 * Persist picked bytes in the WOPI host's file store and resolve the
 * authorized contents URL for them; null when this deployment has no store.
 */
async function uploadToServerStore(name: string, bytes: Uint8Array): Promise<string | null> {
  const base = filesBase()
  try {
    const uploaded = await fetch(`${base}/upload?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes as unknown as BodyInit,
    })
    if (!uploaded.ok) return null
    const listing = await fetch(`${base}/files.json`)
    if (!listing.ok) return null
    const files = (await listing.json()) as { name: string; contentUrl?: string }[]
    const contentUrl = files.find((file) => file.name === name)?.contentUrl
    return contentUrl ? resolveServerContentUrl(contentUrl, base) : null
  } catch {
    return null
  }
}

/**
 * One WPS-style picker shared by every editor. The chosen format determines
 * the destination editor, so File > Open never has to bounce through Home.
 */
export function pickOfficeFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = OFFICE_FILE_ACCEPT
    input.hidden = true
    document.body.append(input)

    const finish = (file: File | null): void => {
      input.remove()
      resolve(file)
    }
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => finish(null), { once: true })
    input.click()
  })
}

export async function openOfficeFile(file: File): Promise<void> {
  const ext = extensionOf(file.name)
  const route = OFFICE_ROUTES[ext]
  if (!route) throw new Error(`unsupported file type: .${ext || '?'} (${OFFICE_FILE_ACCEPT})`)

  const safeName = file.name.replace(/^.*[\\/]/, '')
  const bytes = new Uint8Array(await file.arrayBuffer())

  // Web shells persist the document in the server file store and open it
  // through its contents URL: bytes parked only in this browser's IndexedDB
  // disappear for every other device (and after a storage wipe), which used
  // to reopen as a silent blank editor.
  let src = `local/${safeName}`
  let recent: Omit<RecentEntry, 'ts'> = { key: src, name: safeName, ext }
  const contentUrl = isTauri() ? null : await uploadToServerStore(safeName, bytes)
  if (contentUrl !== null) {
    src = contentUrl
    recent = { key: `server:${safeName}`, name: safeName, ext, contentUrl }
  } else {
    if (!isTauri()) {
      console.warn(`[open-office-file] file store unavailable — ${safeName} stays browser-local`)
    }
    await platform.writeFile(src, bytes)
  }
  pushRecent(recent)

  let href = `#/${route}?src=${encodeURIComponent(src)}`
  // Each renderer consumes a source only once. Reset its guard before routing
  // so File > Open can switch formats without a costly full page reload.
  if (route === 'docs') resetPendingDocumentSource()
  else if (route === 'sheets') resetPendingWorkbookSource()
  else if (route === 'slides') resetPendingSlidesSource()
  else resetPendingPdfSource()
  if (window.location.hash === href) {
    href = `${href}&open=${Date.now().toString(36)}`
  }
  window.location.hash = href
}

export async function pickAndOpenOfficeFile(): Promise<boolean> {
  const file = await pickOfficeFile()
  if (!file) return false
  try {
    await openOfficeFile(file)
    return true
  } catch (error) {
    window.alert(`无法打开文件：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
