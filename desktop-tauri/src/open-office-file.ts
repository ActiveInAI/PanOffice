import { platform } from './bridge/platform'
import { resetPendingWorkbookSource } from './bridge/sheets-api'

export const OFFICE_FILE_ACCEPT = '.docx,.xlsx,.pptx,.pdf'

export const OFFICE_ROUTES: Readonly<Record<string, 'docs' | 'sheets' | 'slides' | 'pdf'>> = {
  docx: 'docs',
  xlsx: 'sheets',
  pptx: 'slides',
  pdf: 'pdf',
}

interface RecentOfficeFile {
  key: string
  name: string
  ext: string
  ts: number
}

const RECENTS_KEY = 'panoffice.recents'

function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

function rememberLocalFile(key: string, file: File, ext: string): void {
  let previous: RecentOfficeFile[] = []
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')
    if (Array.isArray(parsed)) previous = parsed as RecentOfficeFile[]
  } catch {
    // A damaged recent-files cache must never block opening a real document.
  }
  const next = [
    { key, name: file.name, ext, ts: Date.now() },
    ...previous.filter((entry) => entry.key !== key),
  ].slice(0, 30)
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
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
  const key = `local/${safeName}`
  await platform.writeFile(key, new Uint8Array(await file.arrayBuffer()))
  rememberLocalFile(key, file, ext)

  const href = `#/${route}?src=${encodeURIComponent(key)}`
  if (route === 'sheets') {
    resetPendingWorkbookSource()
    window.location.hash = href
    return
  }

  // The other editors still use module-scoped pending-source guards. A real
  // reload resets them and keeps repeated cross-format switching deterministic.
  window.location.hash = href
  window.location.reload()
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
