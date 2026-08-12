import { isTauri, platform, writeFileDeferred } from './bridge/platform'
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

/** Byte counts as a compact progress figure: `2.1/5.6MB`. */
function progressMb(done: number, total: number): string {
  const mb = (n: number) => (n / 1048576).toFixed(1)
  return `${mb(done)}/${mb(total)}MB`
}

/**
 * Persist picked bytes in the WOPI host's file store and resolve the
 * authorized contents URL for them; null when this deployment has no store.
 * Upload runs over XHR so a slow uplink shows real progress instead of a
 * silent stall.
 */
async function uploadToServerStore(
  name: string,
  bytes: Uint8Array,
  onProgress?: (message: string) => void,
): Promise<string | null> {
  const base = filesBase()
  try {
    const uploaded = await new Promise<boolean>((resolveUpload) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${base}/upload?name=${encodeURIComponent(name)}`)
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.timeout = 300_000
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          const percent = Math.floor((event.loaded / event.total) * 100)
          onProgress?.(`上传中 ${percent}%（${progressMb(event.loaded, event.total)}）`)
        }
      }
      xhr.onload = () => resolveUpload(xhr.status >= 200 && xhr.status < 300)
      xhr.onerror = () => resolveUpload(false)
      xhr.ontimeout = () => resolveUpload(false)
      xhr.send(bytes as unknown as XMLHttpRequestBodyInit)
    })
    if (!uploaded) return null
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

export async function openOfficeFile(
  file: File,
  onProgress?: (message: string) => void,
): Promise<void> {
  const ext = extensionOf(file.name)
  const route = OFFICE_ROUTES[ext]
  if (!route) throw new Error(`unsupported file type: .${ext || '?'} (${OFFICE_FILE_ACCEPT})`)

  const safeName = file.name.replace(/^.*[\\/]/, '')
  const bytes = new Uint8Array(await file.arrayBuffer())

  // Web shells persist the document in the server file store — bytes parked
  // only in this browser's IndexedDB disappear for every other device — but
  // how much of that the user waits for depends on where the engine runs:
  //  - docx/pdf/pptx render in the browser and the picked bytes are already
  //    here: open instantly, sync to the store in the background.
  //  - xlsx parses on the server: the upload must finish first (1× raw bytes,
  //    then the host stages it in place), so it reports real progress.
  let src = `local/${safeName}`
  let recent: Omit<RecentEntry, 'ts'> = { key: src, name: safeName, ext }
  if (isTauri()) {
    await platform.writeFile(src, bytes)
  } else if (route === 'sheets') {
    const contentUrl = await uploadToServerStore(safeName, bytes, onProgress)
    if (contentUrl !== null) {
      src = contentUrl
      recent = { key: `server:${safeName}`, name: safeName, ext, contentUrl }
    } else {
      console.warn(`[open-office-file] file store unavailable — ${safeName} stays browser-local`)
      await platform.writeFile(src, bytes)
    }
  } else {
    await writeFileDeferred(src, bytes)
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
