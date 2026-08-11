export interface RecentEntry {
  key: string
  name: string
  ext: string
  ts: number
  contentUrl?: string
}

export const RECENTS_KEY = 'panoffice.recents'

export function loadRecents(): RecentEntry[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]') as RecentEntry[]
  } catch {
    return []
  }
}

export function persistRecents(entries: RecentEntry[]): void {
  // Authorized WOPI URLs are refreshed from /files.json and never persisted.
  localStorage.setItem(
    RECENTS_KEY,
    JSON.stringify(
      entries.map(({ key, name, ext, ts }) => ({ key, name, ext, ts })),
    ),
  )
}

export function pushRecent(entry: Omit<RecentEntry, 'ts'>): RecentEntry[] {
  const rest = loadRecents().filter((recent) => recent.key !== entry.key)
  const list: RecentEntry[] = [{ ...entry, ts: Date.now() }, ...rest].slice(0, 30)
  persistRecents(list)
  return list
}

export function removeRecent(entries: RecentEntry[], key: string): RecentEntry[] {
  return entries.filter((entry) => entry.key !== key)
}
